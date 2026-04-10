'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch } from '@/lib/api'
import type { RouteGeofence } from '@/lib/geofence-utils.ts'
import {
  Calendar,
  MapPin,
  Clock,
  ArrowRight,
  CheckCircle2,
  Armchair,
  Bus,
  CalendarDays,
  Users,
  Info,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  Home,
  School,
  Map,
  X,
  Check,
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import dynamic from 'next/dynamic'

// Dynamically import LocationPicker to avoid SSR issues with Leaflet
const LocationPicker = dynamic(() => import('./location-picker'), { ssr: false })

// Helper function to get current user ID
function getCurrentUserId(): number | null {
  if (typeof window === 'undefined') return null
  const userId = localStorage.getItem('user_id')
  return userId ? parseInt(userId, 10) : null
}

type Route = {
  id: number
  name: string
  starting_point: string
  ending_point: string
  starting_point_gps?: string | null
  ending_point_gps?: string | null
  route_radius_km?: number
}

type PickupLocation = {
  id: number
  route_id: number
  name: string
  gps_coordinates: string
}

type SchoolLocation = {
  id: number
  route_id: number
  name: string
  gps_coordinates: string
}

type Vehicle = {
  id: number
  route_id: number
  capacity: number
  license_plate: string
}

type Booking = {
  id: number
  route_id: number
  status: string
  start_date: string
  end_date: string
  seats_booked: number
  selected_seats?: number[]
}

type BookingForm = {
  route_id: string
  pickup_location_id: string
  dropoff_location_id: string
  start_date: string
  end_date: string
  selected_dates: string[]
  service_type: string
  seats_booked: number
}

type CustomLocation = {
  name: string
  address: string
  coordinates: string
}

/** --------- Payment (frontend-only) helpers/types ---------- */
type PaymentStatus = 'IDLE' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED'

function parseCoords(coord: string | null | undefined): { lat: number; lng: number } | null {
  if (!coord) return null
  const parts = coord.split(',').map(s => s.trim())
  if (parts.length !== 2) return null
  const lat = Number(parts[0])
  const lng = Number(parts[1])
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null
  return { lat, lng }
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (x: number) => (x * Math.PI) / 180
  const R = 6371
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2

  return 2 * R * Math.asin(Math.sqrt(h))
}

function serviceTripsMultiplier(serviceType: string) {
  if (serviceType === 'both') return 2
  if (serviceType === 'morning' || serviceType === 'evening') return 1
  return 1
}

const SERVICE_TYPES = [
  {
    value: 'morning',
    label: 'Morning Service',
    desc: 'Home to school transportation',
    time: '6:00 AM - 9:00 AM',
  },
  {
    value: 'evening',
    label: 'Evening Service',
    desc: 'School to home transportation',
    time: '3:00 PM - 6:00 PM',
  },
  {
    value: 'both',
    label: 'Full Day Service',
    desc: 'Morning and evening transportation',
    time: 'Both directions',
  },
]

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export default function BookingFlow() {
  const [step, setStep] = useState(1)
  const [routes, setRoutes] = useState<Route[]>([])
  const [pickupLocations, setPickupLocations] = useState<PickupLocation[]>([])
  const [schoolLocations, setSchoolLocations] = useState<SchoolLocation[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null)
  const [availableSeats, setAvailableSeats] = useState<number>(0)
  const [loading, setLoading] = useState(false)
  const [loadingSeats, setLoadingSeats] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [redirectCountdown, setRedirectCountdown] = useState(5)

  // ✅ Route geofence
  const [selectedRouteGeofence, setSelectedRouteGeofence] = useState<RouteGeofence | null>(null)

  // Map picker state
  const [showPickupMapPicker, setShowPickupMapPicker] = useState(false)
  const [showDropoffMapPicker, setShowDropoffMapPicker] = useState(false)
  const [customPickupLocation, setCustomPickupLocation] = useState<CustomLocation | null>(null)
  const [customDropoffLocation, setCustomDropoffLocation] = useState<CustomLocation | null>(null)

  // Calendar state
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth())
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear())

  const [form, setForm] = useState<BookingForm>({
    route_id: '',
    pickup_location_id: '',
    dropoff_location_id: '',
    start_date: '',
    end_date: '',
    selected_dates: [],
    service_type: '',
    seats_booked: 1,
  })

  /** ---------------- Payment state ---------------- */
  const [createdBookingId, setCreatedBookingId] = useState<number | null>(null)
  const [estimatedFare, setEstimatedFare] = useState<number | null>(null)
  const [distanceKm, setDistanceKm] = useState<number | null>(null)

  const [payerPhone, setPayerPhone] = useState('')
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>('IDLE')
  const [paymentId, setPaymentId] = useState<number | null>(null)
  const [paymentReceipt, setPaymentReceipt] = useState<string | null>(null)
  const [paymentError, setPaymentError] = useState<string | null>(null)

  // ✅ track when we started payment, so we can detect cancel/timeout via STK query + timeout
  const [paymentStartedAt, setPaymentStartedAt] = useState<number | null>(null)

  useEffect(() => {
    fetchRoutes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (form.route_id) {
      fetchLocationsForRoute(parseInt(form.route_id))
      fetchVehiclesForRoute(parseInt(form.route_id))
    } else {
      setPickupLocations([])
      setSchoolLocations([])
      setVehicles([])
      setSelectedVehicle(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.route_id])

  useEffect(() => {
    if (selectedVehicle && form.selected_dates.length > 0) {
      fetchAvailableSeats()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVehicle, form.selected_dates])

  // Auto-redirect countdown after successful booking
  useEffect(() => {
    if (success && redirectCountdown > 0) {
      const timer = setTimeout(() => setRedirectCountdown(prev => prev - 1), 1000)
      return () => clearTimeout(timer)
    } else if (success && redirectCountdown === 0) {
      window.location.href = '/dashboard/parent'
    }
  }, [success, redirectCountdown])

  const fetchRoutes = async () => {
    try {
      const res = await apiFetch('/routes', { credentials: 'include' })
      const data = await res.json()
      setRoutes(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('Failed to fetch routes', err)
      setError('Failed to load routes')
    }
  }

  const fetchLocationsForRoute = async (routeId: number) => {
    try {
      const pickupRes = await apiFetch(`/pickup_locations?route_id=${routeId}`, { credentials: 'include' })
      const pickupData = await pickupRes.json()

      const pickups = Array.isArray(pickupData)
        ? pickupData
        : Array.isArray(pickupData?.pickup_locations)
          ? pickupData.pickup_locations
          : []

      setPickupLocations(pickups)

      const schoolRes = await apiFetch('/school-locations/all', { credentials: 'include' })
      const schoolData = await schoolRes.json()

      const schools = Array.isArray(schoolData)
        ? schoolData.filter((s: SchoolLocation) => s.route_id === routeId)
        : []

      setSchoolLocations(schools)
    } catch (err) {
      console.error('Failed to fetch locations', err)
    }
  }

  const fetchVehiclesForRoute = async (routeId: number) => {
    try {
      const res = await apiFetch(`/vehicles?route_id=${routeId}`, { credentials: 'include' })
      const data = await res.json()

      const vehicleList = Array.isArray(data) ? data : Array.isArray(data?.vehicles) ? data.vehicles : []
      setVehicles(vehicleList)

      if (vehicleList.length > 0) {
        setSelectedVehicle(vehicleList[0])
        setAvailableSeats(vehicleList[0].capacity)
      }
    } catch (err) {
      console.error('Failed to fetch vehicles', err)
    }
  }

  const fetchAvailableSeats = async () => {
    if (!selectedVehicle || form.selected_dates.length === 0) return

    setLoadingSeats(true)
    try {
      const res = await apiFetch(`/bookings?route_id=${form.route_id}`, { credentials: 'include' })
      const data = await res.json()

      const bookings: Booking[] = Array.isArray(data) ? data : []

      let maxBookedSeats = 0

      form.selected_dates.forEach(selectedDate => {
        const dateBookings = bookings.filter((booking: Booking) => {
          if (booking.status !== 'active') return false

          const bookingStart = new Date(booking.start_date)
          const bookingEnd = new Date(booking.end_date)
          const checkDate = new Date(selectedDate)

          return checkDate >= bookingStart && checkDate <= bookingEnd
        })

        const totalSeatsOnDate = dateBookings.reduce((sum, b) => sum + b.seats_booked, 0)
        maxBookedSeats = Math.max(maxBookedSeats, totalSeatsOnDate)
      })

      const available = selectedVehicle.capacity - maxBookedSeats
      setAvailableSeats(Math.max(0, available))

      if (form.seats_booked > available) {
        setForm(prev => ({ ...prev, seats_booked: Math.max(1, available) }))
      }
    } catch (err) {
      console.error('Failed to fetch available seats', err)
      setAvailableSeats(selectedVehicle.capacity)
    } finally {
      setLoadingSeats(false)
    }
  }

  const createPickupLocation = async (customLocation: CustomLocation, routeId: number): Promise<number | null> => {
    try {
      const res = await apiFetch('/pickup_locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          route_id: routeId,
          name: customLocation.name,
          gps_coordinates: customLocation.coordinates,
        }),
      })

      if (!res.ok) {
        const errorData = await res.json()
        throw new Error(errorData.error || 'Failed to create pickup location')
      }

      const data = await res.json()
      const locationId = data.pickup_location?.id || data.location?.id

      if (!locationId) throw new Error('No location ID returned from server')
      return locationId
    } catch (err: any) {
      console.error('Error creating pickup location:', err)
      throw new Error(`Failed to create pickup location: ${err.message}`)
    }
  }

  const createSchoolLocation = async (customLocation: CustomLocation, routeId: number): Promise<number | null> => {
    try {
      const res = await apiFetch('/school-locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          route_id: routeId,
          name: customLocation.name,
          gps_coordinates: customLocation.coordinates,
        }),
      })

      if (!res.ok) {
        const errorData = await res.json()
        throw new Error(errorData.error || 'Failed to create school location')
      }

      const data = await res.json()
      const locationId = data.location?.id || data.school_location?.id

      if (!locationId) throw new Error('No location ID returned from server')
      return locationId
    } catch (err: any) {
      console.error('Error creating school location:', err)
      throw new Error(`Failed to create school location: ${err.message}`)
    }
  }

  const getDaysInMonth = (month: number, year: number) => new Date(year, month + 1, 0).getDate()
  const getFirstDayOfMonth = (month: number, year: number) => new Date(year, month, 1).getDay()

  const toLocalYMD = (d: Date) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const parseLocalYMD = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number)
    return new Date(y, (m || 1) - 1, d || 1)
  }

  const isDateSelected = (date: Date) => form.selected_dates.includes(toLocalYMD(date))

  const isDateDisabled = (date: Date) => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return date < today
  }

  const toggleDate = (date: Date) => {
    if (isDateDisabled(date)) return

    const dateStr = toLocalYMD(date)

    setForm(prev => {
      const isSelected = prev.selected_dates.includes(dateStr)
      const newDates = isSelected
        ? prev.selected_dates.filter(d => d !== dateStr)
        : [...prev.selected_dates, dateStr].sort()

      const startDate = newDates.length > 0 ? newDates[0] : ''
      const endDate = newDates.length > 0 ? newDates[newDates.length - 1] : ''

      return { ...prev, selected_dates: newDates, start_date: startDate, end_date: endDate }
    })
  }

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(currentMonth, currentYear)
    const firstDay = getFirstDayOfMonth(currentMonth, currentYear)

    const days = []

    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="aspect-square" />)
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentYear, currentMonth, day)
      const selected = isDateSelected(date)
      const disabled = isDateDisabled(date)
      const isToday = date.toDateString() === new Date().toDateString()

      days.push(
        <button
          key={day}
          onClick={() => toggleDate(date)}
          disabled={disabled}
          className={cn(
            'aspect-square rounded-lg flex items-center justify-center text-sm font-medium transition-all duration-200',
            'hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-400 relative',
            selected && 'bg-slate-900 text-white hover:bg-slate-800',
            !selected && !disabled && 'bg-white border border-slate-200 text-slate-900',
            disabled && 'bg-slate-50 text-slate-300 cursor-not-allowed',
            isToday && !selected && 'border-2 border-slate-900',
          )}
        >
          <span className="relative z-10">{day}</span>
          {selected && (
            <div className="absolute top-1 right-1">
              <Check className="w-3 h-3" />
            </div>
          )}
        </button>,
      )
    }

    return days
  }

  const previousMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11)
      setCurrentYear(currentYear - 1)
    } else {
      setCurrentMonth(currentMonth - 1)
    }
  }

  const nextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0)
      setCurrentYear(currentYear + 1)
    } else {
      setCurrentMonth(currentMonth + 1)
    }
  }

  const incrementSeats = () => {
    if (form.seats_booked < availableSeats) {
      setForm(prev => ({ ...prev, seats_booked: prev.seats_booked + 1 }))
    }
  }

  const decrementSeats = () => {
    if (form.seats_booked > 1) {
      setForm(prev => ({ ...prev, seats_booked: prev.seats_booked - 1 }))
    }
  }

  /** ------------------ Fare estimate ------------------ */
  useEffect(() => {
    if (!form.route_id) { setEstimatedFare(null); setDistanceKm(null); return }
    if (!form.service_type) { setEstimatedFare(null); setDistanceKm(null); return }
    if (form.selected_dates.length === 0) { setEstimatedFare(null); setDistanceKm(null); return }

    let pickupCoordStr: string | null = null
    if (customPickupLocation?.coordinates) pickupCoordStr = customPickupLocation.coordinates
    else if (form.pickup_location_id) {
      const p = pickupLocations.find(x => String(x.id) === String(form.pickup_location_id))
      pickupCoordStr = p?.gps_coordinates || null
    }

    let dropoffCoordStr: string | null = null
    if (customDropoffLocation?.coordinates) dropoffCoordStr = customDropoffLocation.coordinates
    else if (form.dropoff_location_id) {
      const s = schoolLocations.find(x => String(x.id) === String(form.dropoff_location_id))
      dropoffCoordStr = s?.gps_coordinates || null
    }

    const a = parseCoords(pickupCoordStr)
    const b = parseCoords(dropoffCoordStr)
    if (!a || !b) { setEstimatedFare(null); setDistanceKm(null); return }

    const km = haversineKm(a, b)
    setDistanceKm(km)

    const BASE_FEE = 0
    const PER_KM = 0.3

    const trips = form.selected_dates.length * serviceTripsMultiplier(form.service_type)
    const seats = Math.max(1, form.seats_booked)

    const perTrip = BASE_FEE + PER_KM * km
    const total = perTrip * trips * seats

    setEstimatedFare(Math.max(0, Math.round(total)))
  }, [
    form.route_id,
    form.pickup_location_id,
    form.dropoff_location_id,
    form.selected_dates,
    form.service_type,
    form.seats_booked,
    customPickupLocation?.coordinates,
    customDropoffLocation?.coordinates,
    pickupLocations,
    schoolLocations,
  ])

  /** ------------------ Booking submit ------------------ */
  const handleSubmit = async () => {
    setLoading(true)
    setError(null)

    try {
      const userId = getCurrentUserId()
      if (!userId) {
        setError('User not authenticated. Please log in again.')
        setLoading(false)
        return
      }

      const routeId = parseInt(form.route_id)

      let pickupLocationId = form.pickup_location_id ? parseInt(form.pickup_location_id) : null
      let dropoffLocationId = form.dropoff_location_id ? parseInt(form.dropoff_location_id) : null

      if (customPickupLocation && !pickupLocationId) {
        try {
          const createdId = await createPickupLocation(customPickupLocation, routeId)
          if (!createdId) throw new Error('Failed to create custom pickup location')
          pickupLocationId = createdId
        } catch (err: any) {
          setError(err.message || 'Failed to create custom pickup location')
          setLoading(false)
          return
        }
      }

      if (customDropoffLocation && !dropoffLocationId) {
        try {
          const createdId = await createSchoolLocation(customDropoffLocation, routeId)
          if (!createdId) throw new Error('Failed to create custom dropoff location')
          dropoffLocationId = createdId
        } catch (err: any) {
          setError(err.message || 'Failed to create custom dropoff location')
          setLoading(false)
          return
        }
      }

      if (!pickupLocationId) {
        setError('Pickup location is required')
        setLoading(false)
        return
      }

      if (!dropoffLocationId) {
        setError('Dropoff location is required')
        setLoading(false)
        return
      }

      const daysOfWeek = new Set<number>()
      form.selected_dates.forEach(dateStr => {
        const date = parseLocalYMD(dateStr)
        const dayOfWeek = date.getDay()
        daysOfWeek.add(dayOfWeek === 0 ? 7 : dayOfWeek)
      })

      const payload = {
        user_id: userId,
        route_id: routeId,
        pickup_location_id: pickupLocationId,
        dropoff_location_id: dropoffLocationId,
        start_date: form.start_date,
        end_date: form.end_date,
        days_of_week: Array.from(daysOfWeek).sort().join(','),
        service_type: form.service_type,
        seats_booked: form.seats_booked,
      }

      const res = await apiFetch('/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Booking failed')

      const bookingId = data.booking_id || data.id || data.booking?.id
      if (!bookingId) throw new Error('Booking created but booking id was not returned')

      setCreatedBookingId(Number(bookingId))
      setStep(5)
    } catch (err: any) {
      console.error('Booking error:', err)
      setError(err.message || 'Failed to create booking')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } finally {
      setLoading(false)
    }
  }

  /** ------------------ Payment actions ------------------ */
  const normalizePhone = (p: string) => {
    const s = (p || '').trim().replace(/\s+/g, '')
    if (s.startsWith('+')) return s.slice(1)
    if (s.startsWith('0')) return '254' + s.slice(1)
    if (s.startsWith('7')) return '254' + s
    return s
  }

  const startPayment = async () => {
    setPaymentError(null)
    setPaymentReceipt(null)

    if (!createdBookingId) {
      setPaymentError('Missing booking id. Please go back and confirm booking again.')
      return
    }

    const phone = normalizePhone(payerPhone)
    if (!phone.startsWith('254') || phone.length !== 12) {
      setPaymentError('Enter a valid phone number (07XXXXXXXX or 2547XXXXXXXX).')
      return
    }

    const amount = Math.max(1, estimatedFare ?? 1)

    setPaymentStatus('PENDING')
    setPaymentStartedAt(Date.now())

    try {
      const res = await apiFetch('/payments/stk-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          booking_id: createdBookingId,
          phone_number: phone,
          amount,
        }),
      })

      const data = await res.json()

      const pid = data?.payment?.id || data?.payment_id
      if (!pid) {
        setPaymentStatus('FAILED')
        setPaymentError('Payment started but payment id missing from response.')
        return
      }

      setPaymentId(Number(pid))
    } catch (e: any) {
      setPaymentStatus('FAILED')
      setPaymentError(e?.message || 'Failed to start payment')
    }
  }

  /**
   * ✅ Poll status, and if still pending, call STK query endpoint periodically.
   * IMPORTANT: Your app.py currently does NOT register /payments/stk-query.
   * Add it or this will 404.
   */
  useEffect(() => {
    if (!paymentId) return
    if (paymentStatus !== 'PENDING') return

    let stopped = false
    let ticks = 0

    const poll = async () => {
      if (stopped) return

      const started = paymentStartedAt ?? Date.now()
      const elapsedMs = Date.now() - started

      // hard timeout so UI never spins forever
      if (elapsedMs > 90_000) {
        setPaymentStatus('FAILED')
        setPaymentError('Payment timed out. If you cancelled on your phone, please try again.')
        return
      }

      try {
        const res = await apiFetch(`/payments/${paymentId}`, { credentials: 'include' })
        const data = await res.json()

        const status = String(data.status || '').toUpperCase()
        const desc = String(data.result_desc || '').toLowerCase()

        if (status === 'SUCCESS') {
          setPaymentStatus('SUCCESS')
          setPaymentReceipt(data.mpesa_receipt_number || null)
          setSuccess(true)
          return
        }

        if (status === 'FAILED') {
          if (desc.includes('cancel')) {
            setPaymentStatus('CANCELLED')
            setPaymentError(data.result_desc || 'Payment cancelled.')
          } else {
            setPaymentStatus('FAILED')
            setPaymentError(data.result_desc || 'Payment failed. Please try again.')
          }
          return
        }

        // still pending
        ticks += 1

        // after ~12.5s, then every ~10s: ask backend to query Safaricom
        const shouldQuery = ticks === 5 || (ticks > 5 && ticks % 4 === 0)

        if (shouldQuery) {
          try {
            await apiFetch('/payments/stk-query', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ payment_id: paymentId }),
            })
            // next GET will reflect update if query returns final status
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore transient errors during polling
      }
    }

    const t = setInterval(poll, 2500)
    poll()

    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [paymentId, paymentStatus, paymentStartedAt])

  const canProceedStep1 =
    form.route_id &&
    (form.pickup_location_id || customPickupLocation) &&
    (form.dropoff_location_id || customDropoffLocation)

  const canProceedStep2 = form.selected_dates.length > 0
  const canProceedStep3 = !!form.service_type
  const canProceedStep4 = form.seats_booked > 0 && form.seats_booked <= availableSeats

  const resetForm = () => {
    setForm({
      route_id: '',
      pickup_location_id: '',
      dropoff_location_id: '',
      start_date: '',
      end_date: '',
      selected_dates: [],
      service_type: '',
      seats_booked: 1,
    })
    setCustomPickupLocation(null)
    setCustomDropoffLocation(null)
    setStep(1)
    setSuccess(false)
    setRedirectCountdown(5)
    setError(null)
    setSelectedRouteGeofence(null)
    setCurrentMonth(new Date().getMonth())
    setCurrentYear(new Date().getFullYear())

    // payment reset
    setCreatedBookingId(null)
    setEstimatedFare(null)
    setDistanceKm(null)
    setPayerPhone('')
    setPaymentStatus('IDLE')
    setPaymentId(null)
    setPaymentReceipt(null)
    setPaymentError(null)
    setPaymentStartedAt(null)
  }

  if (success) {
    return (
      <div className="min-h-[600px] flex items-center justify-center p-4 bg-slate-50">
        <Card className="max-w-2xl w-full shadow-lg border border-slate-200">
          <CardContent className="pt-12 pb-12 text-center">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center">
                <CheckCircle2 className="w-12 h-12 text-white" />
              </div>
            </div>

            <h2 className="text-3xl font-bold mb-3 text-slate-900">Booking Confirmed</h2>
            <p className="text-slate-600 mb-8 text-lg">Your school bus booking has been created successfully.</p>

            <div className="flex items-center justify-center gap-6 mb-8">
              <div className="flex items-center gap-2 px-4 py-2 bg-slate-100 rounded-lg">
                <Users className="w-5 h-5 text-slate-600" />
                <span className="font-semibold text-slate-900">
                  {form.seats_booked} Seat{form.seats_booked > 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex items-center gap-2 px-4 py-2 bg-slate-100 rounded-lg">
                <CalendarDays className="w-5 h-5 text-slate-600" />
                <span className="font-semibold text-slate-900">
                  {form.selected_dates.length} Day{form.selected_dates.length > 1 ? 's' : ''}
                </span>
              </div>
            </div>

            {paymentReceipt && (
              <div className="mb-6 p-4 bg-green-50 rounded-lg border border-green-200">
                <p className="text-sm text-green-900 font-medium">
                  Payment receipt: <span className="font-bold">{paymentReceipt}</span>
                </p>
              </div>
            )}

            <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <p className="text-sm text-blue-900 font-medium">
                Redirecting to dashboard in <span className="font-bold text-lg">{redirectCountdown}</span> seconds...
              </p>
            </div>

            <div className="space-y-3 max-w-xs mx-auto">
              <Button
                onClick={() => (window.location.href = '/dashboard/parent')}
                className="w-full bg-slate-900 hover:bg-slate-800 h-12 text-base"
              >
                Go to Dashboard Now
              </Button>
              <Button variant="outline" onClick={resetForm} className="w-full h-12 border-2 border-slate-200">
                Make Another Booking
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="max-w-4xl mx-auto space-y-6 px-4">
        {/* Progress Steps */}
        <Card className="border border-slate-200 shadow-sm">
          <CardContent className="pt-8 pb-8">
            <div className="flex items-center justify-between">
              {[
                { id: 1, label: 'Route & Locations', icon: MapPin },
                { id: 2, label: 'Schedule', icon: Calendar },
                { id: 3, label: 'Service Type', icon: Clock },
                { id: 4, label: 'Seats', icon: Users },
                { id: 5, label: 'Payment', icon: CheckCircle2 },
              ].map((item, index) => (
                <div key={item.id} className="flex flex-1 items-center">
                  <div className="flex flex-col items-center text-center">
                    <div className="relative">
                      <div
                        className={cn(
                          'w-12 h-12 rounded-full flex items-center justify-center font-semibold border-2 transition-all',
                          step >= item.id ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-300 text-slate-400',
                        )}
                      >
                        {step > item.id ? <Check className="w-5 h-5" /> : <item.icon className="w-5 h-5" />}
                      </div>
                    </div>

                    <span className={cn('mt-3 font-medium text-xs transition-colors', step >= item.id ? 'text-slate-900' : 'text-slate-400')}>
                      {item.label}
                    </span>
                  </div>

                  {index < 4 && (
                    <div className="flex-1 mx-4 h-0.5 bg-slate-200">
                      <div className={cn('h-full bg-slate-900 transition-all duration-300', step > item.id ? 'w-full' : 'w-0')} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive" className="border-red-200">
            <AlertDescription className="font-medium">{error}</AlertDescription>
          </Alert>
        )}

        {/* Step 1 */}
        {step === 1 && (
          <Card className="border border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="flex items-center gap-3 text-2xl text-slate-900">
                <MapPin className="w-6 h-6" />
                Route & Locations
              </CardTitle>
              <CardDescription>Select your route and specify pickup and dropoff locations</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              <div className="space-y-3">
                <Label className="text-base font-semibold text-slate-900">Select Route</Label>

                <Select
                  value={form.route_id}
                  onValueChange={(val) => {
                    setForm({ ...form, route_id: val, pickup_location_id: '', dropoff_location_id: '' })
                    setCustomPickupLocation(null)
                    setCustomDropoffLocation(null)

                    const selectedRoute = routes.find(r => String(r.id) === val)
                    if (selectedRoute) {
                      setSelectedRouteGeofence({
                        starting_point_gps: selectedRoute.starting_point_gps || null,
                        ending_point_gps: selectedRoute.ending_point_gps || null,
                        route_radius_km: selectedRoute.route_radius_km || 5.0,
                      })
                    } else {
                      setSelectedRouteGeofence(null)
                    }
                  }}
                >
                  <SelectTrigger className="h-12 border-slate-300">
                    <SelectValue placeholder="Choose your route" />
                  </SelectTrigger>
                  <SelectContent>
                    {routes.map(route => (
                      <SelectItem key={route.id} value={String(route.id)}>
                        <div className="flex items-center gap-3 py-1">
                          <Badge variant="secondary" className="bg-slate-900 text-white">
                            {route.name}
                          </Badge>
                          <span className="text-slate-600">
                            {route.starting_point} → {route.ending_point}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {selectedRouteGeofence && selectedRouteGeofence.starting_point_gps && (
                  <Alert className="bg-blue-50 border-blue-200 mt-4">
                    <Info className="h-5 w-5 text-blue-600" />
                    <AlertDescription className="ml-2 text-blue-900">
                      <div className="font-semibold mb-1">Route Geofence Active</div>
                      <div className="text-sm">
                        Custom locations must be within {selectedRouteGeofence.route_radius_km}km of the{' '}
                        {routes.find(r => String(r.id) === form.route_id)?.name} corridor.
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
              </div>

              {form.route_id && (
                <>
                  {/* Pickup */}
                  <div className="space-y-3">
                    <Label className="text-base font-semibold text-slate-900 flex items-center gap-2">
                      <Home className="w-4 h-4" />
                      Pickup Location
                    </Label>

                    {customPickupLocation ? (
                      <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                        <div className="flex items-start gap-3">
                          <MapPin className="w-5 h-5 text-slate-600 mt-0.5 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-slate-900 mb-1">{customPickupLocation.name}</div>
                            <div className="text-sm text-slate-600 mb-1">{customPickupLocation.address}</div>
                            <div className="text-xs text-slate-500">{customPickupLocation.coordinates}</div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setCustomPickupLocation(null)
                              setForm({ ...form, pickup_location_id: '' })
                            }}
                            className="text-slate-500 hover:text-slate-700"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <Select value={form.pickup_location_id} onValueChange={(val) => setForm({ ...form, pickup_location_id: val })}>
                          <SelectTrigger className="h-12 border-slate-300">
                            <SelectValue placeholder="Choose pickup location" />
                          </SelectTrigger>
                          <SelectContent>
                            {pickupLocations.map(loc => (
                              <SelectItem key={loc.id} value={String(loc.id)}>
                                <div className="flex flex-col items-start py-1">
                                  <span className="font-medium">{loc.name}</span>
                                  <span className="text-xs text-slate-500">{loc.gps_coordinates}</span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <div className="relative">
                          <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-slate-200"></div>
                          </div>
                          <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-white px-2 text-slate-500">or</span>
                          </div>
                        </div>

                        <Button type="button" variant="outline" onClick={() => setShowPickupMapPicker(true)} className="w-full h-12 border-slate-300 hover:bg-slate-50">
                          <Map className="w-4 h-4 mr-2" />
                          Select Custom Location on Map
                        </Button>
                      </>
                    )}
                  </div>

                  {/* Dropoff */}
                  <div className="space-y-3">
                    <Label className="text-base font-semibold text-slate-900 flex items-center gap-2">
                      <School className="w-4 h-4" />
                      Dropoff Location
                    </Label>

                    {customDropoffLocation ? (
                      <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                        <div className="flex items-start gap-3">
                          <MapPin className="w-5 h-5 text-slate-600 mt-0.5 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-slate-900 mb-1">{customDropoffLocation.name}</div>
                            <div className="text-sm text-slate-600 mb-1">{customDropoffLocation.address}</div>
                            <div className="text-xs text-slate-500">{customDropoffLocation.coordinates}</div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setCustomDropoffLocation(null)
                              setForm({ ...form, dropoff_location_id: '' })
                            }}
                            className="text-slate-500 hover:text-slate-700"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <Select value={form.dropoff_location_id} onValueChange={(val) => setForm({ ...form, dropoff_location_id: val })}>
                          <SelectTrigger className="h-12 border-slate-300">
                            <SelectValue placeholder="Choose dropoff location" />
                          </SelectTrigger>
                          <SelectContent>
                            {schoolLocations.map(loc => (
                              <SelectItem key={loc.id} value={String(loc.id)}>
                                <div className="flex flex-col items-start py-1">
                                  <span className="font-medium">{loc.name}</span>
                                  <span className="text-xs text-slate-500">{loc.gps_coordinates}</span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <div className="relative">
                          <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-slate-200"></div>
                          </div>
                          <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-white px-2 text-slate-500">or</span>
                          </div>
                        </div>

                        <Button type="button" variant="outline" onClick={() => setShowDropoffMapPicker(true)} className="w-full h-12 border-slate-300 hover:bg-slate-50">
                          <Map className="w-4 h-4 mr-2" />
                          Select Custom Location on Map
                        </Button>
                      </>
                    )}
                  </div>
                </>
              )}

              <Button className="w-full h-12 bg-slate-900 hover:bg-slate-800 text-base font-medium" disabled={!canProceedStep1} onClick={() => setStep(2)}>
                Continue to Schedule <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Step 2 */}
        {step === 2 && (
          <Card className="border border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="flex items-center gap-3 text-2xl text-slate-900">
                <Calendar className="w-6 h-6" />
                Select Schedule
              </CardTitle>
              <CardDescription>Choose the dates you need the bus service</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              <div className="flex items-center justify-between px-4 py-3 bg-slate-900 rounded-lg">
                <Button variant="ghost" size="icon" onClick={previousMonth} className="h-10 w-10 text-white hover:bg-slate-800">
                  <ChevronLeft className="w-5 h-5" />
                </Button>

                <div className="text-center">
                  <h3 className="text-xl font-semibold text-white">
                    {MONTHS[currentMonth]} {currentYear}
                  </h3>
                </div>

                <Button variant="ghost" size="icon" onClick={nextMonth} className="h-10 w-10 text-white hover:bg-slate-800">
                  <ChevronRight className="w-5 h-5" />
                </Button>
              </div>

              <div className="bg-white rounded-lg p-4 border border-slate-200">
                <div className="grid grid-cols-7 gap-2 mb-3">
                  {DAYS_OF_WEEK.map((day) => (
                    <div key={day} className="text-center text-sm font-semibold py-2 text-slate-600">
                      {day}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-2">{renderCalendar()}</div>
              </div>

              {form.selected_dates.length > 0 && (
                <Alert className="bg-slate-50 border-slate-200">
                  <Info className="h-5 w-5 text-slate-600" />
                  <AlertDescription className="ml-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-semibold text-slate-900">
                          {form.selected_dates.length} Day{form.selected_dates.length > 1 ? 's' : ''} Selected
                        </span>
                        <div className="text-sm text-slate-600 mt-1">
                          {new Date(form.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} -{' '}
                          {new Date(form.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setForm(prev => ({ ...prev, selected_dates: [], start_date: '', end_date: '' }))}
                        className="text-slate-600 hover:text-slate-900"
                      >
                        Clear all
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex gap-4">
                <Button variant="outline" onClick={() => setStep(1)} className="flex-1 h-12 border-slate-300">
                  Back
                </Button>
                <Button className="flex-1 h-12 bg-slate-900 hover:bg-slate-800" disabled={!canProceedStep2} onClick={() => setStep(3)}>
                  Continue <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3 */}
        {step === 3 && (
          <Card className="border border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="flex items-center gap-3 text-2xl text-slate-900">
                <Clock className="w-6 h-6" />
                Service Type
              </CardTitle>
              <CardDescription>Choose when you need the bus service</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-6">
              {SERVICE_TYPES.map((type) => (
                <button
                  key={type.value}
                  onClick={() => setForm({ ...form, service_type: type.value })}
                  className={cn(
                    'w-full p-5 rounded-lg border-2 text-left transition-all',
                    form.service_type === type.value ? 'border-slate-900 bg-slate-50' : 'border-slate-200 bg-white hover:border-slate-300',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-lg text-slate-900 mb-1">{type.label}</div>
                      <div className="text-sm text-slate-600 mb-1">{type.desc}</div>
                      <div className="text-xs text-slate-500">{type.time}</div>
                    </div>
                    {form.service_type === type.value && <CheckCircle2 className="w-6 h-6 text-slate-900" />}
                  </div>
                </button>
              ))}

              <div className="flex gap-4 pt-2">
                <Button variant="outline" onClick={() => setStep(2)} className="flex-1 h-12 border-slate-300">
                  Back
                </Button>
                <Button className="flex-1 h-12 bg-slate-900 hover:bg-slate-800" disabled={!canProceedStep3} onClick={() => setStep(4)}>
                  Continue <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 4 */}
        {step === 4 && (
          <Card className="border border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="flex items-center gap-3 text-2xl text-slate-900">
                <Users className="w-6 h-6" />
                Number of Seats
              </CardTitle>
              {selectedVehicle && (
                <CardDescription className="flex items-center gap-4 pt-2">
                  <Badge variant="secondary" className="bg-slate-900 text-white">
                    {selectedVehicle.license_plate}
                  </Badge>
                  <span>
                    <Bus className="w-4 h-4 inline mr-1" />
                    {selectedVehicle.capacity} Total Capacity
                  </span>
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              {loadingSeats ? (
                <div className="flex items-center justify-center py-16">
                  <div className="text-center">
                    <div className="w-12 h-12 border-3 border-slate-900 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-slate-600 font-medium">Checking availability...</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="bg-slate-900 rounded-lg p-8 text-center">
                    <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-white/10 mb-4">
                      <Armchair className="w-10 h-10 text-white" />
                    </div>
                    <h3 className="text-4xl font-bold text-white mb-2">{availableSeats} Seats</h3>
                    <p className="text-slate-300">Available out of {selectedVehicle?.capacity} total</p>
                  </div>

                  <div className="flex items-center justify-center gap-6">
                    <Button variant="outline" size="icon" onClick={decrementSeats} disabled={form.seats_booked <= 1} className="h-12 w-12 border-slate-300">
                      <Minus className="w-5 h-5" />
                    </Button>

                    <div className="text-center min-w-[120px] p-4 bg-slate-50 rounded-lg border border-slate-200">
                      <div className="text-4xl font-bold text-slate-900 mb-1">{form.seats_booked}</div>
                      <div className="text-sm text-slate-600 font-medium">Seat{form.seats_booked > 1 ? 's' : ''}</div>
                    </div>

                    <Button
                      variant="outline"
                      size="icon"
                      onClick={incrementSeats}
                      disabled={form.seats_booked >= availableSeats}
                      className="h-12 w-12 border-slate-300"
                    >
                      <Plus className="w-5 h-5" />
                    </Button>
                  </div>

                  <div className="flex gap-2 justify-center flex-wrap">
                    {[1, 2, 3, 5, 10].filter(num => num <= availableSeats).map(num => (
                      <Button
                        key={num}
                        variant={form.seats_booked === num ? 'default' : 'outline'}
                        onClick={() => setForm(prev => ({ ...prev, seats_booked: num }))}
                        className={cn(
                          'min-w-[60px] h-10',
                          form.seats_booked === num ? 'bg-slate-900 hover:bg-slate-800' : 'border-slate-300',
                        )}
                      >
                        {num}
                      </Button>
                    ))}
                  </div>

                  <Alert
                    className={cn(
                      'border-2',
                      availableSeats === 0
                        ? 'bg-red-50 border-red-200'
                        : availableSeats < 5
                          ? 'bg-orange-50 border-orange-200'
                          : 'bg-blue-50 border-blue-200',
                    )}
                  >
                    <Info
                      className={cn(
                        'h-5 w-5',
                        availableSeats === 0 ? 'text-red-600' : availableSeats < 5 ? 'text-orange-600' : 'text-blue-600',
                      )}
                    />
                    <AlertDescription className="ml-2 font-medium">
                      {availableSeats === 0 ? (
                        <span className="text-red-700">No seats available for the selected dates. Please choose different dates.</span>
                      ) : availableSeats < 5 ? (
                        <span className="text-orange-700">
                          Only {availableSeats} seat{availableSeats > 1 ? 's' : ''} remaining. Book now.
                        </span>
                      ) : (
                        <span className="text-blue-700">
                          Seats will be reserved for all {form.selected_dates.length} selected day{form.selected_dates.length > 1 ? 's' : ''}.
                        </span>
                      )}
                    </AlertDescription>
                  </Alert>

                  <div className="bg-slate-50 rounded-lg p-5 border border-slate-200 space-y-3">
                    <h4 className="font-semibold text-slate-900 mb-3">Booking Summary</h4>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-slate-600">Number of seats</span>
                        <Badge variant="secondary" className="bg-slate-900 text-white">
                          {form.seats_booked}
                        </Badge>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-600">Number of days</span>
                        <Badge variant="outline" className="border-slate-300">
                          {form.selected_dates.length}
                        </Badge>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-600">Service type</span>
                        <Badge variant="outline" className="border-slate-300">
                          {SERVICE_TYPES.find(t => t.value === form.service_type)?.label}
                        </Badge>
                      </div>

                      <div className="flex justify-between items-center pt-2 border-t border-slate-200">
                        <span className="text-slate-900 font-semibold">Estimated total</span>
                        <span className="text-slate-900 font-bold">{estimatedFare == null ? 'KES —' : `KES ${estimatedFare}`}</span>
                      </div>
                      {distanceKm != null && (
                        <div className="text-xs text-slate-500">
                          Based on approx. {distanceKm.toFixed(1)} km from pickup to school.
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}

              <div className="flex gap-4">
                <Button variant="outline" onClick={() => setStep(3)} className="flex-1 h-12 border-slate-300">
                  Back
                </Button>
                <Button
                  className="flex-1 h-12 bg-slate-900 hover:bg-slate-800"
                  disabled={!canProceedStep4 || loading || loadingSeats}
                  onClick={handleSubmit}
                >
                  {loading ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                      Creating Booking...
                    </>
                  ) : (
                    <>
                      Confirm Booking
                      <CheckCircle2 className="w-5 h-5 ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 5 */}
        {step === 5 && (
          <Card className="border border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="flex items-center gap-3 text-2xl text-slate-900">
                <CheckCircle2 className="w-6 h-6" />
                Payment
              </CardTitle>
              <CardDescription>Pay to complete your booking</CardDescription>
            </CardHeader>

            <CardContent className="space-y-6 pt-6">
              <div className="bg-slate-50 rounded-lg p-5 border border-slate-200 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Booking ID</span>
                  <Badge variant="secondary" className="bg-slate-900 text-white">
                    {createdBookingId ?? '—'}
                  </Badge>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Estimated distance</span>
                  <span className="font-semibold text-slate-900">{distanceKm == null ? '—' : `${distanceKm.toFixed(1)} km`}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Trips</span>
                  <span className="font-semibold text-slate-900">{form.selected_dates.length * serviceTripsMultiplier(form.service_type)}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Seats</span>
                  <span className="font-semibold text-slate-900">{form.seats_booked}</span>
                </div>

                <div className="flex justify-between items-center pt-2 border-t border-slate-200">
                  <span className="text-slate-900 font-semibold">Estimated total</span>
                  <span className="text-slate-900 font-bold text-lg">{estimatedFare == null ? 'KES —' : `KES ${estimatedFare}`}</span>
                </div>

                <div className="text-xs text-slate-500 pt-2">
                  This is an estimate based on pickup/dropoff distance. You can tune pricing later.
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-base font-semibold text-slate-900">M-Pesa Phone Number</Label>
                <Input
                  value={payerPhone}
                  onChange={(e) => setPayerPhone(e.target.value)}
                  placeholder="e.g. 0718117543 or 254718117543"
                  className="h-12"
                  disabled={paymentStatus === 'PENDING' || paymentStatus === 'SUCCESS'}
                />
                <div className="text-xs text-slate-500">We’ll send an STK prompt to this phone.</div>
              </div>

              {paymentError && (
                <Alert variant="destructive" className="border-red-200">
                  <AlertDescription className="font-medium">{paymentError}</AlertDescription>
                </Alert>
              )}

              {paymentStatus === 'PENDING' && (
                <Alert className="bg-blue-50 border-blue-200">
                  <Info className="h-5 w-5 text-blue-600" />
                  <AlertDescription className="ml-2 text-blue-900">Payment request sent. Check your phone and enter M-Pesa PIN. We’re confirming…</AlertDescription>
                </Alert>
              )}

              {paymentStatus === 'CANCELLED' && (
                <Alert className="bg-orange-50 border-orange-200">
                  <Info className="h-5 w-5 text-orange-600" />
                  <AlertDescription className="ml-2 text-orange-900">Payment cancelled on phone. Please try again.</AlertDescription>
                </Alert>
              )}

              {paymentStatus === 'SUCCESS' && (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <AlertDescription className="ml-2 text-green-900">
                    Payment successful{paymentReceipt ? ` (Receipt: ${paymentReceipt})` : ''}.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-col sm:flex-row gap-4">
                <Button variant="outline" onClick={() => setStep(4)} className="flex-1 h-12 border-slate-300" disabled={paymentStatus === 'PENDING'}>
                  Back
                </Button>

                <Button
                  className="flex-1 h-12 bg-slate-900 hover:bg-slate-800"
                  disabled={!createdBookingId || paymentStatus === 'PENDING' || paymentStatus === 'SUCCESS'}
                  onClick={startPayment}
                >
                  {paymentStatus === 'PENDING' ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                      Waiting for M-Pesa…
                    </>
                  ) : (
                    <>
                      Pay with M-Pesa
                      <ArrowRight className="w-5 h-5 ml-2" />
                    </>
                  )}
                </Button>
              </div>

              <div className="text-xs text-slate-500">
                Tip: If you’re testing on sandbox and want a quick success, you can temporarily lower the amount to 1 in backend/FE.
              </div>
            </CardContent>
          </Card>
        )}

        {/* Map Picker Dialogs */}
        <Dialog open={showPickupMapPicker} onOpenChange={setShowPickupMapPicker}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Select Pickup Location</DialogTitle>
              {selectedRouteGeofence && selectedRouteGeofence.starting_point_gps && (
                <DialogDescription>Location must be within {selectedRouteGeofence.route_radius_km}km of the route corridor</DialogDescription>
              )}
            </DialogHeader>
            <LocationPicker
              type="pickup"
              routeGeofence={selectedRouteGeofence}
              onLocationConfirm={(location) => {
                setCustomPickupLocation({
                  name: location.name || 'Custom Pickup Location',
                  address: location.address,
                  coordinates: `${location.lat},${location.lng}`,
                })
                setForm({ ...form, pickup_location_id: '' })
                setShowPickupMapPicker(false)
              }}
            />
          </DialogContent>
        </Dialog>

        <Dialog open={showDropoffMapPicker} onOpenChange={setShowDropoffMapPicker}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Select Dropoff Location</DialogTitle>
              {selectedRouteGeofence && selectedRouteGeofence.starting_point_gps && (
                <DialogDescription>Location must be within {selectedRouteGeofence.route_radius_km}km of the route corridor</DialogDescription>
              )}
            </DialogHeader>
            <LocationPicker
              type="dropoff"
              routeGeofence={selectedRouteGeofence}
              onLocationConfirm={(location) => {
                setCustomDropoffLocation({
                  name: location.name || 'Custom School Location',
                  address: location.address,
                  coordinates: `${location.lat},${location.lng}`,
                })
                setForm({ ...form, dropoff_location_id: '' })
                setShowDropoffMapPicker(false)
              }}
            />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}