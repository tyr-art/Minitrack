from flask import Flask
from flask_restful import Api 
from flask_cors import CORS
from routes.pickup_locations import PickupLocationDetail
from models import db 
from flask_migrate import Migrate
from flask_jwt_extended import JWTManager
from routes.auth import Login, Signup, Logout, Me
from routes.user import CreateDriver, GetDrivers, GetUsers, UpdateUser, DeleteUser, CreateAdmin
from routes.user_role import UserRoleList, UserRoleDetail

# from routes.payment import PaymentStkPush, PaymentCallback, PaymentDetail
from routes.booking import BookingList, BookingDetail
from routes.trip import TripToday, TripPickup, TripDropoff
from routes.school_location import CreateSchoolLocation, GetAllSchoolLocations, GetSchoolLocation, UpdateSchoolLocation, DeleteSchoolLocation

from routes.vehicle import VehicleList, VehicleDetail
from routes.route import RouteList, RouteDetail
from routes.pickup_locations import PickupLocationList, PickupLocationDetail,PickupLocationByRoute, PickupLocationBulk
# from routes.payment import (
#     PaymentStkPush, PaymentCallback, PaymentDetail,
#     BookingPayments, BookingLatestPayment
# )
from routes.payment import (
    PaymentStkPush, PaymentCallback, PaymentDetail,
    BookingPayments, BookingLatestPayment,
    PaymentStkQuery,  # ✅ add this
)


import os
from dotenv import load_dotenv

load_dotenv()

def create_app():

    app = Flask(__name__)
    
    import os

    app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL")import os

    app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL")    
        app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    
    app.secret_key = "super-secret-key"
    app.config["JWT_SECRET_KEY"] = "super-secret-key"
    
    app.config["JWT_TOKEN_LOCATION"] = ["cookies"]
    app.config["JWT_ACCESS_COOKIE_NAME"] = "access_token_cookie"
    app.config["JWT_COOKIE_SECURE"] = False
    app.config["JWT_COOKIE_CSRF_PROTECT"] = False
    app.config["JWT_COOKIE_SAMESITE"] = "Lax"
    app.config["JWT_COOKIE_SECURE"] = False
    
    jwt = JWTManager(app)

    db.init_app(app)
    migrate = Migrate(app, db)
    CORS(
    app,
    supports_credentials=True,
    origins=[
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://your-vercel-app.vercel.app"
]
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"]
)

    api = Api(app)

    api.add_resource(Login, '/login')
    api.add_resource(Signup, '/signup')
    api.add_resource(Logout, '/logout')
    api.add_resource(Me, '/me')
    
    api.add_resource(CreateDriver, '/drivers')
    api.add_resource(GetDrivers, '/drivers')
    api.add_resource(GetUsers, '/users')
    api.add_resource(UpdateUser, '/users/<int:user_id>')
    api.add_resource(DeleteUser, '/users/<int:user_id>')
    api.add_resource(CreateAdmin, '/admins')
    
    api.add_resource(UserRoleList, '/user_roles')
    api.add_resource(UserRoleDetail, '/user_roles/<int:role_id>')


    api.add_resource(TripToday, '/trips/today')
    api.add_resource(TripPickup, '/trips/<int:trip_id>/pickup')
    api.add_resource(TripDropoff, '/trips/<int:trip_id>/dropoff')

    api.add_resource(BookingList, '/bookings')
    api.add_resource(BookingDetail, '/bookings/<int:booking_id>')
    
    api.add_resource(CreateSchoolLocation, "/school-locations")
    api.add_resource(GetAllSchoolLocations, "/school-locations/all")
    api.add_resource(GetSchoolLocation, "/school-locations/<int:location_id>")
    api.add_resource(UpdateSchoolLocation, "/school-locations/<int:location_id>")
    api.add_resource(DeleteSchoolLocation, "/school-locations/<int:location_id>")
    
    api.add_resource(VehicleList, '/vehicles')
    api.add_resource(VehicleDetail, '/vehicles/<int:vehicle_id>')
    
    api.add_resource(RouteList, '/routes')
    api.add_resource(RouteDetail, '/routes/<int:route_id>')

    api.add_resource(PickupLocationList, '/pickup_locations')
    api.add_resource(PickupLocationDetail, '/pickup_locations/<int:id>')
    api.add_resource(PickupLocationByRoute, '/pickup_locations/route/<int:route_id>')
    api.add_resource(PickupLocationBulk, '/pickup_locations/bulk')

    api.add_resource(PaymentStkPush, "/payments/stk-push")
    api.add_resource(PaymentCallback, "/payments/callback")
    api.add_resource(PaymentDetail, "/payments/<int:payment_id>")
    # NEW:
    api.add_resource(BookingPayments, "/bookings/<int:booking_id>/payments")
    api.add_resource(BookingLatestPayment, "/bookings/<int:booking_id>/payments/latest")
    api.add_resource(PaymentStkQuery, "/payments/stk-query")
    

    
    return app 

app = create_app()
if __name__ == '__main__':
        port = int(os.environ.get("PORT", 5000))
        app.run(host="0.0.0.0", port=port, debug=True)



