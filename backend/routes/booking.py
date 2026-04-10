from flask import request
from flask_restful import Resource
from datetime import datetime, date, timedelta
from models import db, Booking, Vehicle, User, Trip, Route, PickupLocation, SchoolLocation

# ----------------------------
# Payment-reservation settings
# ----------------------------
# If booking is still pending_payment after this time, we cancel it to release seats.
PENDING_PAYMENT_EXPIRY_MINUTES = 15


def generate_trips_for_booking(booking):
    trips = []
    current_date = booking.start_date
    days_of_week = [int(d) for d in booking.days_of_week.split(',')]

    while current_date <= booking.end_date:
        if current_date.isoweekday() in days_of_week:
            if booking.service_type in ['morning', 'both']:
                trips.append(Trip(
                    booking_id=booking.id,
                    trip_date=current_date,
                    service_time='morning',
                    status='scheduled'
                ))

            if booking.service_type in ['evening', 'both']:
                trips.append(Trip(
                    booking_id=booking.id,
                    trip_date=current_date,
                    service_time='evening',
                    status='scheduled'
                ))

        current_date += timedelta(days=1)

    db.session.bulk_save_objects(trips)
    db.session.commit()

    return len(trips)


def validate_booking_capacity(vehicle_id, start_date, end_date, seats_requested):
    vehicle = Vehicle.query.get(vehicle_id)
    if not vehicle:
        return False, 0, "Vehicle not found"

    overlapping_trips = Trip.query.join(Booking).filter(
        Booking.route_id == vehicle.route_id,
        Trip.trip_date >= start_date,
        Trip.trip_date <= end_date,
        Trip.status.in_(['scheduled', 'picked_up'])  # active trips only
    ).all()

    from collections import defaultdict
    seats_by_date = defaultdict(int)

    for trip in overlapping_trips:
        # trip.booking is available via relationship
        seats_by_date[trip.trip_date] += trip.booking.seats_booked

    max_seats_used = max(seats_by_date.values()) if seats_by_date else 0
    available = vehicle.capacity - max_seats_used

    if seats_requested <= available:
        return True, available, ""
    else:
        return False, available, f"Not enough seats. Only {available} seats available, but {seats_requested} requested"


def validate_date_range(start_date, end_date):
    if start_date < date.today():
        return False, "Start date cannot be in the past"

    if end_date < start_date:
        return False, "End date must be after start date"

    max_days = 180
    if (end_date - start_date).days > max_days:
        return False, f"Booking period cannot exceed {max_days} days"

    return True, ""


def validate_days_of_week(days_string):
    try:
        days = [int(d) for d in days_string.split(',')]

        if not all(1 <= d <= 7 for d in days):
            return False, "Days must be between 1 (Monday) and 7 (Sunday)"

        if len(days) != len(set(days)):
            return False, "Duplicate days not allowed"

        if len(days) == 0:
            return False, "At least one day must be specified"

        return True, ""
    except Exception:
        return False, "Invalid days format. Use comma-separated numbers (e.g., '1,3,5' for Mon/Wed/Fri)"


def validate_service_type(service_type):
    valid_types = ['morning', 'evening', 'both']
    if service_type not in valid_types:
        return False, f"Service type must be one of: {', '.join(valid_types)}"
    return True, ""


def _is_pending_booking_expired(booking: Booking) -> bool:
    """
    Booking is considered expired if:
    - status is pending_payment
    - booking_date is older than expiry window
    """
    if booking.status != "pending_payment":
        return False

    # booking.booking_date is stored as UTC datetime
    expiry_cutoff = datetime.utcnow() - timedelta(minutes=PENDING_PAYMENT_EXPIRY_MINUTES)
    return booking.booking_date < expiry_cutoff


def _cancel_pending_booking_and_release_trips(booking: Booking) -> bool:
    """
    Cancel booking and cancel upcoming trips to release capacity.
    """
    if booking.status != "pending_payment":
        return False

    booking.status = "cancelled"

    # Cancel all scheduled/picked_up trips for this booking that are not completed yet
    Trip.query.filter(
        Trip.booking_id == booking.id,
        Trip.status.in_(['scheduled', 'picked_up'])
    ).update({'status': 'cancelled'})

    return True


def sync_booking_completion_from_trips(booking: Booking) -> bool:
    if not booking:
        return False

    # Only active bookings can auto-complete
    if booking.status != 'active':
        return False

    trips = booking.trips or []
    if len(trips) == 0:
        return False

    any_incomplete = any(t.status in ['scheduled', 'picked_up'] for t in trips)

    if not any_incomplete:
        booking.status = 'completed'
        return True

    return False


def serialize_booking(booking, include_trips=False):
    did_update = False

    # ✅ Auto-cancel pending_payment bookings that expired
    if _is_pending_booking_expired(booking):
        did_update = _cancel_pending_booking_and_release_trips(booking)

    # ✅ Auto-complete active bookings
    if booking.status == 'active' and booking.end_date < date.today():
        booking.status = 'completed'
        did_update = True
    else:
        did_update = sync_booking_completion_from_trips(booking) or did_update

    if did_update:
        db.session.commit()

    result = {
        "booking_id": booking.id,
        "user_id": booking.user_id,
        "user_name": booking.user.name,
        "route_id": booking.route_id,
        "route_name": booking.route.name,
        "pickup_location_id": booking.pickup_location_id,
        "pickup_location_name": booking.pickup_location.name,
        "pickup_location_gps": booking.pickup_location.gps_coordinates,
        "dropoff_location_id": booking.dropoff_location_id,
        "dropoff_location_name": booking.dropoff_location.name,
        "dropoff_location_gps": booking.dropoff_location.gps_coordinates,
        "booking_date": booking.booking_date.isoformat(),
        "start_date": booking.start_date.isoformat(),
        "end_date": booking.end_date.isoformat(),
        "status": booking.status,
        "seats_booked": booking.seats_booked,
        "service_type": booking.service_type,
        "days_of_week": booking.days_of_week,
        # Helpful for frontend to show “pay within X minutes”
        "payment_expiry_minutes": PENDING_PAYMENT_EXPIRY_MINUTES if booking.status == "pending_payment" else None,
    }

    if include_trips:
        result["trips"] = [serialize_trip(trip) for trip in booking.trips]
        result["total_trips"] = len(booking.trips)
        result["completed_trips"] = len([t for t in booking.trips if t.status == 'completed'])
        result["upcoming_trips"] = len([t for t in booking.trips if t.status == 'scheduled'])

    return result


def serialize_trip(trip):
    booking = trip.booking

    if trip.service_time == 'evening':
        pickup_location = booking.dropoff_location
        dropoff_location = booking.pickup_location
    else:
        pickup_location = booking.pickup_location
        dropoff_location = booking.dropoff_location

    return {
        "trip_id": trip.id,
        "booking_id": trip.booking_id,
        "trip_date": trip.trip_date.isoformat(),
        "service_time": trip.service_time,
        "status": trip.status,
        "pickup_location_id": pickup_location.id,
        "pickup_location_name": pickup_location.name,
        "pickup_location_gps": pickup_location.gps_coordinates,
        "dropoff_location_id": dropoff_location.id,
        "dropoff_location_name": dropoff_location.name,
        "dropoff_location_gps": dropoff_location.gps_coordinates,
        "pickup_time": trip.pickup_time.isoformat() if trip.pickup_time else None,
        "actual_pickup_time": trip.actual_pickup_time.isoformat() if trip.actual_pickup_time else None,
        "actual_dropoff_time": trip.actual_dropoff_time.isoformat() if trip.actual_dropoff_time else None,
        "driver_notes": trip.driver_notes,
    }


# ----------------------------
# RESOURCE CLASSES
# ----------------------------

class BookingList(Resource):
    def get(self):
        user_id = request.args.get('user_id', type=int)
        route_id = request.args.get('route_id', type=int)
        status = request.args.get('status')

        query = Booking.query

        if user_id:
            query = query.filter_by(user_id=user_id)

        if route_id:
            query = query.filter_by(route_id=route_id)

        if status:
            query = query.filter_by(status=status)

        bookings = query.all()

        response = []
        for booking in bookings:
            response.append(serialize_booking(booking, include_trips=False))

        return response, 200

    def post(self):
        data = request.get_json() or {}

        required_fields = [
            'user_id', 'route_id', 'pickup_location_id', 'dropoff_location_id',
            'start_date', 'end_date', 'days_of_week', 'service_type', 'seats_booked'
        ]

        for field in required_fields:
            if field not in data:
                return {"error": f"{field} is required"}, 400

        user = User.query.get(data['user_id'])
        if not user:
            return {"error": "User not found"}, 404

        route = Route.query.get(data['route_id'])
        if not route:
            return {"error": "Route not found"}, 404

        pickup_location = PickupLocation.query.get(data['pickup_location_id'])
        if not pickup_location:
            return {"error": "Pickup location not found"}, 404
        if pickup_location.route_id != data['route_id']:
            return {"error": "Pickup location does not belong to selected route"}, 400

        dropoff_location = SchoolLocation.query.get(data['dropoff_location_id'])
        if not dropoff_location:
            return {"error": "Dropoff location not found"}, 404
        if dropoff_location.route_id != data['route_id']:
            return {"error": "Dropoff location does not belong to selected route"}, 400

        vehicle = Vehicle.query.filter_by(route_id=data['route_id']).first()
        if not vehicle:
            return {"error": "No vehicles available on this route"}, 404

        try:
            start_date = datetime.strptime(data['start_date'], '%Y-%m-%d').date()
            end_date = datetime.strptime(data['end_date'], '%Y-%m-%d').date()
        except ValueError:
            return {"error": "Invalid date format. Use YYYY-MM-DD"}, 400

        is_valid, error_msg = validate_date_range(start_date, end_date)
        if not is_valid:
            return {"error": error_msg}, 400

        is_valid, error_msg = validate_days_of_week(data['days_of_week'])
        if not is_valid:
            return {"error": error_msg}, 400

        is_valid, error_msg = validate_service_type(data['service_type'])
        if not is_valid:
            return {"error": error_msg}, 400

        seats_booked = data['seats_booked']
        if not isinstance(seats_booked, int) or seats_booked < 1:
            return {"error": "seats_booked must be a positive integer"}, 400

        is_valid, available_seats, error_msg = validate_booking_capacity(
            vehicle.id,
            start_date,
            end_date,
            seats_booked
        )
        if not is_valid:
            return {"error": error_msg}, 409

        # ✅ REAL-APP FLOW: booking starts as pending_payment (not confirmed yet)
        booking = Booking(
            user_id=data['user_id'],
            route_id=data['route_id'],
            pickup_location_id=data['pickup_location_id'],
            dropoff_location_id=data['dropoff_location_id'],
            booking_date=datetime.utcnow(),
            start_date=start_date,
            end_date=end_date,
            status='pending_payment',
            seats_booked=seats_booked,
            service_type=data['service_type'],
            days_of_week=data['days_of_week']
        )

        db.session.add(booking)
        db.session.commit()

        # Reserve capacity by generating trips immediately
        try:
            trips_created = generate_trips_for_booking(booking)
        except Exception as e:
            db.session.delete(booking)
            db.session.commit()
            return {"error": f"Failed to generate trips: {str(e)}"}, 500

        response = serialize_booking(booking, include_trips=False)
        response["trips_created"] = trips_created
        response["message"] = "Booking created. Payment required to confirm."
        response["payment_required"] = True

        return response, 201


class BookingDetail(Resource):
    def get(self, booking_id):
        booking = Booking.query.get(booking_id)
        if not booking:
            return {"error": "Booking not found"}, 404

        response = serialize_booking(booking, include_trips=True)
        return response, 200

    def patch(self, booking_id):
        booking = Booking.query.get(booking_id)
        if not booking:
            return {"error": "Booking not found"}, 404

        data = request.get_json() or {}
        if 'status' not in data:
            return {"error": "status field is required"}, 400

        new_status = data['status']

        # Allow updates for active only (your original logic)
        if booking.status == 'active':
            if new_status not in ['cancelled', 'completed']:
                return {"error": "Can only set status to 'cancelled' or 'completed'"}, 400
        elif booking.status in ['cancelled', 'completed']:
            return {"error": f"Cannot modify a {booking.status} booking"}, 409
        elif booking.status == 'pending_payment':
            # In a real app you usually allow cancelling pending booking
            if new_status not in ['cancelled']:
                return {"error": "Can only cancel a pending_payment booking"}, 400
        else:
            return {"error": f"Invalid current status: {booking.status}"}, 400

        old_status = booking.status
        booking.status = new_status

        if new_status == 'cancelled':
            Trip.query.filter(
                Trip.booking_id == booking_id,
                Trip.trip_date >= date.today(),
                Trip.status.in_(['scheduled', 'picked_up'])
            ).update({'status': 'cancelled'})

        elif new_status == 'completed':
            Trip.query.filter(
                Trip.booking_id == booking_id,
                Trip.status.in_(['scheduled', 'picked_up'])
            ).update({'status': 'completed'})

        db.session.commit()

        response = serialize_booking(booking, include_trips=True)
        response["message"] = f"Booking status changed from '{old_status}' to '{new_status}'"

        return response, 200

    def delete(self, booking_id):
        booking = Booking.query.get(booking_id)
        if not booking:
            return {"error": "Booking not found"}, 404

        if booking.status not in ['completed', 'cancelled']:
            return {
                "error": "Can only delete completed or cancelled bookings",
                "current_status": booking.status
            }, 400

        try:
            db.session.delete(booking)
            db.session.commit()

            return {
                "message": "Booking deleted successfully",
                "booking_id": booking_id
            }, 200

        except Exception as e:
            db.session.rollback()
            return {"error": f"Failed to delete booking: {str(e)}"}, 500