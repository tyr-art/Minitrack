# routes/payment.py
from models import db, Booking, Payment, Trip  # add Trip
import os
import base64
import requests
from datetime import datetime, timedelta

from flask import request
from flask_restful import Resource
from flask_jwt_extended import jwt_required, get_jwt_identity

from models import db, Booking, Payment


# ----------------------------
# Helpers
# ----------------------------

def _get_env(name: str, default: str = None, *, required: bool = True) -> str:
    val = os.environ.get(name, default)
    if val is None:
        if required:
            raise RuntimeError(f"Missing env var: {name}")
        return ""

    if isinstance(val, str):
        val = val.strip().replace("\r", "").replace("\n", "")

    if required and not val:
        raise RuntimeError(f"Missing env var: {name}")
    return val


def _daraja_base_url() -> str:
    env = _get_env("DARAJA_ENV", "sandbox", required=False).lower()
    return "https://sandbox.safaricom.co.ke" if env == "sandbox" else "https://api.safaricom.co.ke"


def _timestamp() -> str:
    return datetime.now().strftime("%Y%m%d%H%M%S")


def _password(shortcode: str, passkey: str, timestamp: str) -> str:
    raw = f"{shortcode}{passkey}{timestamp}".encode()
    return base64.b64encode(raw).decode()


def _normalize_msisdn(phone: str) -> str:
    p = (phone or "").strip().replace(" ", "")
    if p.startswith("+"):
        p = p[1:]
    if p.startswith("0"):
        p = "254" + p[1:]
    if p.startswith("7"):
        p = "254" + p
    return p


def _user_id_from_identity() -> int:
    ident = get_jwt_identity()
    return ident["id"] if isinstance(ident, dict) else int(ident)


def _safe_json(res: requests.Response):
    try:
        return res.json()
    except Exception:
        return None


def _access_token() -> str:
    key = _get_env("DARAJA_CONSUMER_KEY")
    secret = _get_env("DARAJA_CONSUMER_SECRET")

    auth = base64.b64encode(f"{key}:{secret}".encode()).decode()
    url = f"{_daraja_base_url()}/oauth/v1/generate?grant_type=client_credentials"

    res = requests.get(url, headers={"Authorization": f"Basic {auth}"}, timeout=20)
    if not res.ok:
        raise RuntimeError(f"OAuth failed {res.status_code}: {res.text[:500]}")
    data = res.json()
    token = data.get("access_token")
    if not token:
        raise RuntimeError("OAuth response missing access_token")
    return token


def _parse_daraja_callback(body: dict) -> dict:
    stk = (((body.get("Body") or {}).get("stkCallback")) or {})

    out = {
        "checkout_request_id": stk.get("CheckoutRequestID"),
        "merchant_request_id": stk.get("MerchantRequestID"),
        "result_code": stk.get("ResultCode"),
        "result_desc": stk.get("ResultDesc"),
        "amount": None,
        "mpesa_receipt": None,
        "transaction_date": None,
        "phone_number": None,
    }

    items = (((stk.get("CallbackMetadata") or {}).get("Item")) or [])
    for it in items:
        name = it.get("Name")
        val = it.get("Value")
        if name == "Amount":
            out["amount"] = val
        elif name == "MpesaReceiptNumber":
            out["mpesa_receipt"] = val
        elif name == "TransactionDate":
            out["transaction_date"] = val
        elif name == "PhoneNumber":
            out["phone_number"] = val

    return out


def _transaction_date_from_int(v):
    if not v:
        return None
    try:
        s = str(int(v))
        return datetime.strptime(s, "%Y%m%d%H%M%S")
    except Exception:
        return None


def _norm_status(s: str) -> str:
    return (s or "").strip().upper()


def _serialize_payment(payment: Payment) -> dict:
    return {
        "id": payment.id,
        "booking_id": payment.booking_id,
        "phone_number": payment.phone_number,
        "amount": payment.amount,
        "status": payment.status,
        "result_code": payment.result_code,
        "result_desc": payment.result_desc,
        "mpesa_receipt_number": payment.mpesa_receipt_number,
        "checkout_request_id": payment.checkout_request_id,
        "merchant_request_id": payment.merchant_request_id,
        "transaction_date": payment.transaction_date.isoformat() if payment.transaction_date else None,
        "created_at": payment.created_at.isoformat() if payment.created_at else None,
        "updated_at": payment.updated_at.isoformat() if payment.updated_at else None,
    }


# ----------------------------
# Resources
# ----------------------------

class PaymentStkPush(Resource):
    """
    POST /payments/stk-push
    Body: { booking_id, phone_number, amount }
    """

    @jwt_required()
    def post(self):
        data = request.get_json() or {}

        booking_id = data.get("booking_id")
        phone_number = data.get("phone_number")
        amount = data.get("amount")

        if booking_id is None or not phone_number or amount is None:
            return {"error": "booking_id, phone_number, amount are required"}, 400

        try:
            booking_id = int(booking_id)
        except Exception:
            return {"error": "booking_id must be an integer"}, 400

        try:
            amount = int(amount)
        except Exception:
            return {"error": "amount must be an integer"}, 400

        if amount < 1:
            return {"error": "amount must be >= 1"}, 400

        user_id = _user_id_from_identity()

        booking = Booking.query.get(booking_id)
        if not booking:
            return {"error": "Booking not found"}, 404
        if booking.user_id != user_id:
            return {"error": "Not allowed"}, 403

        # ✅ real app rule: only pay if booking is pending_payment
        if booking.status == "active":
            return {"error": "Booking already confirmed/paid"}, 409
        if booking.status in ("cancelled", "completed"):
            return {"error": f"Cannot pay for a {booking.status} booking"}, 409
        if booking.status != "pending_payment":
            return {"error": f"Booking is not payable in status '{booking.status}'"}, 409

        shortcode = _get_env("DARAJA_SHORTCODE")
        passkey = _get_env("DARAJA_PASSKEY")
        callback_url = _get_env("DARAJA_CALLBACK_URL")

        if not shortcode.isdigit():
            return {"error": "DARAJA_SHORTCODE must be numeric"}, 500

        msisdn = _normalize_msisdn(phone_number)
        if (not msisdn.isdigit()) or (not msisdn.startswith("254")) or (len(msisdn) != 12):
            return {"error": "phone_number must be valid and normalize to 2547XXXXXXXX"}, 400

        # ✅ duplicate protection: reuse a recent pending payment
        five_minutes_ago = datetime.utcnow() - timedelta(minutes=5)
        recent = (
            Payment.query
            .filter(Payment.booking_id == booking_id)
            .order_by(Payment.created_at.desc())
            .first()
        )

        if recent:
            rs = _norm_status(recent.status)
            if rs == "PENDING" and recent.created_at >= five_minutes_ago:
                if str(recent.phone_number) == str(msisdn) and int(recent.amount) == int(amount):
                    return {
                        "message": "Payment already pending. Reusing existing request.",
                        "payment": _serialize_payment(recent)
                    }, 200

        # Build STK payload
        ts = _timestamp()
        pwd = _password(shortcode, passkey, ts)

        try:
            token = _access_token()
        except Exception as e:
            return {"error": "Failed to get access token", "details": str(e)[:500]}, 502

        payload = {
            "BusinessShortCode": shortcode,
            "Password": pwd,
            "Timestamp": ts,
            "TransactionType": "CustomerPayBillOnline",
            "Amount": amount,
            "PartyA": msisdn,
            "PartyB": shortcode,
            "PhoneNumber": msisdn,
            "CallBackURL": callback_url,
            "AccountReference": f"BOOKING-{booking_id}",
            "TransactionDesc": f"MiniTrack booking {booking_id}",
        }

        url = f"{_daraja_base_url()}/mpesa/stkpush/v1/processrequest"

        try:
            res = requests.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                timeout=30
            )
        except requests.RequestException as e:
            return {"error": "STK push network error", "details": str(e)[:500]}, 502

        if not res.ok:
            err_json = _safe_json(res)
            return {
                "error": "STK push failed",
                "status_code": res.status_code,
                "details": err_json if err_json is not None else (res.text[:800] if res.text else "")
            }, 502

        resp = res.json()

        payment = Payment(
            booking_id=booking_id,
            phone_number=msisdn,
            amount=amount,
            status="PENDING",
            merchant_request_id=resp.get("MerchantRequestID"),
            checkout_request_id=resp.get("CheckoutRequestID"),
            result_code=resp.get("ResponseCode"),
            result_desc=resp.get("ResponseDescription"),
        )
        db.session.add(payment)
        db.session.commit()

        return {
            "message": resp.get("CustomerMessage", "Success. Request accepted for processing"),
            "payment": _serialize_payment(payment)
        }, 201


class PaymentCallback(Resource):
    """
    POST /payments/callback
    Safaricom calls this (no auth)
    """

    def post(self):
        body = request.get_json(silent=True) or {}
        parsed = _parse_daraja_callback(body)

        checkout_request_id = parsed.get("checkout_request_id")
        if not checkout_request_id:
            return {"result": "ignored"}, 200

        payment = Payment.query.filter_by(checkout_request_id=checkout_request_id).first()
        if not payment:
            return {"result": "ignored"}, 200

        # Idempotent: already final
        if _norm_status(payment.status) in ("SUCCESS", "FAILED", "CANCELLED"):
            return {"result": "ok"}, 200

        result_code = parsed.get("result_code")
        result_desc = parsed.get("result_desc")

        payment.result_code = str(result_code) if result_code is not None else None
        payment.result_desc = result_desc

        booking = Booking.query.get(payment.booking_id)

        if str(result_code) == "0":
            payment.status = "SUCCESS"
            payment.mpesa_receipt_number = parsed.get("mpesa_receipt")
            payment.transaction_date = _transaction_date_from_int(parsed.get("transaction_date"))

            # ✅ Confirm booking only on success
            if booking and booking.status == "pending_payment":
                booking.status = "active"

        else:
            # Daraja uses non-zero for cancelled/failed. We treat as FAILED.
            payment.status = "FAILED"

            if booking and booking.status == "pending_payment":
                booking.status = "cancelled"
                Trip.query.filter(
                    Trip.booking_id == booking.id,
                    Trip.status.in_(['scheduled', 'picked_up'])
                ).update({'status': 'cancelled'})

        db.session.commit()
        return {"result": "ok"}, 200


class PaymentDetail(Resource):
    @jwt_required()
    def get(self, payment_id):
        user_id = _user_id_from_identity()

        payment = Payment.query.get(payment_id)
        if not payment:
            return {"error": "Payment not found"}, 404

        booking = Booking.query.get(payment.booking_id)
        if not booking or booking.user_id != user_id:
            return {"error": "Not allowed"}, 403

        return _serialize_payment(payment), 200


class BookingPayments(Resource):
    @jwt_required()
    def get(self, booking_id):
        user_id = _user_id_from_identity()

        booking = Booking.query.get(booking_id)
        if not booking:
            return {"error": "Booking not found"}, 404
        if booking.user_id != user_id:
            return {"error": "Not allowed"}, 403

        payments = (
            Payment.query
            .filter_by(booking_id=booking_id)
            .order_by(Payment.created_at.desc())
            .all()
        )

        return {
            "booking_id": booking_id,
            "payments": [_serialize_payment(p) for p in payments]
        }, 200


class BookingLatestPayment(Resource):
    @jwt_required()
    def get(self, booking_id):
        user_id = _user_id_from_identity()

        booking = Booking.query.get(booking_id)
        if not booking:
            return {"error": "Booking not found"}, 404
        if booking.user_id != user_id:
            return {"error": "Not allowed"}, 403

        payment = (
            Payment.query
            .filter_by(booking_id=booking_id)
            .order_by(Payment.created_at.desc())
            .first()
        )

        if not payment:
            return {"booking_id": booking_id, "payment": None}, 200

        return {"booking_id": booking_id, "payment": _serialize_payment(payment)}, 200

class PaymentStkQuery(Resource):
    @jwt_required()
    def post(self):
        data = request.get_json() or {}
        payment_id = data.get("payment_id")

        if payment_id is None:
            return {"error": "payment_id is required"}, 400

        try:
            payment_id = int(payment_id)
        except Exception:
            return {"error": "payment_id must be an integer"}, 400

        user_id = _user_id_from_identity()

        payment = Payment.query.get(payment_id)
        if not payment:
            return {"error": "Payment not found"}, 404

        booking = Booking.query.get(payment.booking_id)
        if not booking or booking.user_id != user_id:
            return {"error": "Not allowed"}, 403

        if _norm_status(payment.status) in ("SUCCESS", "FAILED", "CANCELLED"):
            return {"payment": _serialize_payment(payment), "note": "Already final"}, 200

        if not payment.checkout_request_id:
            return {"error": "Payment missing checkout_request_id"}, 409

        shortcode = _get_env("DARAJA_SHORTCODE")
        passkey = _get_env("DARAJA_PASSKEY")

        ts = _timestamp()
        pwd = _password(shortcode, passkey, ts)

        token = _access_token()

        url = f"{_daraja_base_url()}/mpesa/stkpushquery/v1/query"
        payload = {
            "BusinessShortCode": shortcode,
            "Password": pwd,
            "Timestamp": ts,
            "CheckoutRequestID": payment.checkout_request_id,
        }

        res = requests.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=30
        )

        if not res.ok:
            return {"error": "STK query failed", "status_code": res.status_code, "details": _safe_json(res) or res.text}, 502

        j = res.json()
        rc = str(j.get("ResultCode")) if j.get("ResultCode") is not None else None
        rd = j.get("ResultDesc")

        if rc is not None and rc != "0":
            payment.status = "FAILED"
            payment.result_code = rc
            payment.result_desc = rd

            if booking and booking.status == "pending_payment":
                booking.status = "cancelled"
                Trip.query.filter(
                    Trip.booking_id == booking.id,
                    Trip.status.in_(['scheduled', 'picked_up'])
                ).update({'status': 'cancelled'})

            db.session.commit()

        elif rc == "0":
            payment.status = "SUCCESS"
            payment.result_code = rc
            payment.result_desc = rd
           
            if booking and booking.status == "pending_payment":
                  booking.status = "cancelled"
            try:
                Trip.query.filter(
                    Trip.booking_id == booking.id,
                    Trip.status.in_(['scheduled', 'picked_up'])
                ).update({'status': 'cancelled'})
            except Exception:
                pass

            db.session.commit()

        return {"payment": _serialize_payment(payment), "query": j}, 200