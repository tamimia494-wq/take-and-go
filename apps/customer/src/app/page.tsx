"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Armchair,
  CarFront,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  LocateFixed,
  Lock,
  LogOut,
  Map as MapIcon,
  MessageCircle,
  Minus,
  Phone,
  Plus,
  ShieldCheck,
  Sparkles,
  Users
} from "lucide-react";
import type { FormEvent } from "react";

const LocationPicker = dynamic(() => import("./location-picker"), {
  ssr: false,
  loading: () => <div className="location-map map-placeholder">جارٍ تحميل الخريطة…</div>
});
/** In production NEXT_PUBLIC_API_URL is set; in development fall back to port 4000 on whatever host served the page (works from a phone on the same Wi-Fi). */
function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  const url = configured || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:4000/api` : "http://localhost:4000/api");
  return url.endsWith("/api") ? url : `${url.replace(/\/$/, "")}/api`;
}
const CUSTOMER_TOKEN_KEY = "take-go-customer-token";
const CUSTOMER_PHONE_KEY = "take-go-customer-phone";
const MAX_PASSENGERS = 7;

type Location = { id: string; name: string };
type Option = { id: string; label: string; kind: "ADDON" | "FIELD"; priceJod: number; required: boolean };
type BookingConfig = {
  basePriceJod: number;
  rearSeatPriceJod: number;
  whatsappNumber: string;
  locations: Location[];
  options: Option[];
};
type Point = { latitude: number; longitude: number };
type Coordinates = Point | null;

async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers
      }
    });
  } catch (reason) {
    if (reason instanceof TypeError) throw new Error("تعذر الاتصال بخدمة الحجز. تحقق من الاتصال ثم أعد المحاولة.");
    throw reason;
  }
  const body = await response.text();
  let data: { error?: string } & Record<string, unknown>;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`تعذر قراءة رد الخادم (${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error ?? `تعذر إكمال الطلب (${response.status}).`);
  return data as T;
}

function money(value: number): string {
  return `${new Intl.NumberFormat("ar-JO", { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(value)} د.أ`;
}

function safeStorage(action: (storage: Storage) => void) {
  try {
    action(window.localStorage);
  } catch {
    /* storage blocked (private mode) — the session simply won't persist */
  }
}

/* ---------- Jordanian visual motifs ---------- */

const STAR_POINTS = Array.from({ length: 14 }, (_, index) => {
  const radius = index % 2 === 0 ? 10 : 4.6;
  const angle = -Math.PI / 2 + (index * Math.PI) / 7;
  return `${(12 + radius * Math.cos(angle)).toFixed(2)},${(12 + radius * Math.sin(angle)).toFixed(2)}`;
}).join(" ");

/** The seven-pointed star from the Jordanian flag. */
function JordanStar({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <polygon points={STAR_POINTS} fill="currentColor" />
    </svg>
  );
}

/** Amman skyline: rolling hills, the Citadel columns and the white stone houses. */
function Skyline({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 480 150" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <circle cx="372" cy="46" r="26" className="sky-sun" />
      <path className="sky-hill-back" d="M0 112 C60 82 110 84 170 100 C230 116 270 76 340 80 C400 84 440 104 480 96 V150 H0Z" />
      {/* Citadel – Temple of Hercules */}
      <g className="sky-stone">
        <rect x="92" y="60" width="62" height="6" rx="1" />
        <rect x="96" y="66" width="7" height="34" />
        <rect x="111" y="66" width="7" height="34" />
        <rect x="126" y="66" width="7" height="34" />
        <rect x="141" y="66" width="7" height="34" />
        <rect x="88" y="98" width="70" height="5" rx="1" />
      </g>
      {/* White-stone cube houses */}
      <g className="sky-houses">
        <rect x="214" y="92" width="24" height="22" />
        <rect x="240" y="84" width="20" height="30" />
        <rect x="262" y="96" width="26" height="18" />
        <rect x="290" y="88" width="18" height="26" />
        <rect x="310" y="100" width="22" height="14" />
        <rect x="18" y="104" width="22" height="16" />
        <rect x="42" y="96" width="18" height="24" />
        <rect x="408" y="94" width="22" height="22" />
        <rect x="432" y="102" width="24" height="14" />
      </g>
      <g className="sky-windows">
        <rect x="220" y="98" width="4" height="5" /><rect x="229" y="98" width="4" height="5" />
        <rect x="246" y="90" width="4" height="5" /><rect x="246" y="100" width="4" height="5" />
        <rect x="268" y="102" width="4" height="5" /><rect x="278" y="102" width="4" height="5" />
        <rect x="296" y="94" width="4" height="5" /><rect x="48" y="102" width="4" height="5" />
        <rect x="414" y="100" width="4" height="5" /><rect x="438" y="107" width="4" height="4" />
      </g>
      {/* Flag pole on the Citadel */}
      <g className="sky-flag">
        <rect x="170" y="38" width="2" height="62" />
        <path d="M172 39 h22 l-5 6 5 6 h-22z" />
      </g>
      <path className="sky-hill-front" d="M0 124 C80 108 150 118 230 120 C320 122 380 106 480 116 V150 H0Z" />
      <path className="sky-road" d="M0 140 C120 128 300 146 480 132" />
    </svg>
  );
}

function Brand({ light = false }: { light?: boolean }) {
  return (
    <a className={`brand${light ? " brand-light" : ""}`} href="#" aria-label="Take and Go">
      <span className="brand-mark"><CarFront size={19} strokeWidth={2.2} /></span>
      <span className="brand-name">Take <b>&amp;</b> Go</span>
    </a>
  );
}

/* ---------- Booking pieces ---------- */

function StopField({
  kind,
  title,
  locations,
  locationId,
  onLocationChange,
  customName,
  onCustomNameChange,
  address,
  onAddressChange,
  coordinates,
  onCoordinatesChange,
  onLocate
}: {
  kind: "from" | "to";
  title: string;
  locations: Location[];
  locationId: string;
  onLocationChange: (value: string) => void;
  customName: string;
  onCustomNameChange: (value: string) => void;
  address: string;
  onAddressChange: (value: string) => void;
  coordinates: Coordinates;
  onCoordinatesChange: (value: Point) => void;
  onLocate: () => void;
}) {
  const [mapOpen, setMapOpen] = useState(false);
  return (
    <div className={`stop stop-${kind}`}>
      <span className="stop-dot" aria-hidden="true" />
      <div className="stop-body">
        <div className="stop-title">
          <strong>{title}</strong>
          {coordinates && <span className="pinned"><Check size={13} /> محدد على الخريطة</span>}
        </div>
        <div className="stop-fields">
          <label className="field">
            <span className="field-label">المنطقة</span>
            <span className="input-shell select-shell">
              <select value={locationId} onChange={(event) => onLocationChange(event.target.value)}>
                <option value="other">منطقة أخرى (اكتبها بنفسك)</option>
                {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
              <ChevronDown size={17} className="select-caret" />
            </span>
          </label>
          {locationId === "other" && (
            <label className="field">
              <span className="field-label">اسم المنطقة</span>
              <span className="input-shell">
                <input value={customName} onChange={(event) => onCustomNameChange(event.target.value)} placeholder="مثلاً: جبل عمّان، الصويفية، إربد" required />
              </span>
            </label>
          )}
          <label className="field field-wide">
            <span className="field-label">العنوان بالتفصيل</span>
            <span className="input-shell">
              <input value={address} onChange={(event) => onAddressChange(event.target.value)} placeholder="الشارع، العمارة، أو أقرب معلم معروف" required />
            </span>
          </label>
        </div>
        <div className="stop-actions">
          <button type="button" className="chip-button" onClick={() => { onLocate(); setMapOpen(true); }}>
            <LocateFixed size={15} /> موقعي الحالي
          </button>
          <button type="button" className="chip-button chip-ghost" aria-expanded={mapOpen} onClick={() => setMapOpen((open) => !open)}>
            <MapIcon size={15} /> {mapOpen ? "إخفاء الخريطة" : "حدّد على الخريطة"}
          </button>
        </div>
        {mapOpen && (
          <div className="map-wrap">
            <LocationPicker value={coordinates} onChange={onCoordinatesChange} />
            <span className="map-hint">اضغط على الخريطة لتثبيت النقطة</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Page ---------- */

export default function BookingPage() {
  const [config, setConfig] = useState<BookingConfig | null>(null);
  const [token, setToken] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("register");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [greeting, setGreeting] = useState("أهلاً وسهلاً");
  const [pickupId, setPickupId] = useState("other");
  const [pickupName, setPickupName] = useState("");
  const [pickupAddress, setPickupAddress] = useState("");
  const [pickupCoordinates, setPickupCoordinates] = useState<Coordinates>(null);
  const [destinationId, setDestinationId] = useState("other");
  const [destinationName, setDestinationName] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [destinationCoordinates, setDestinationCoordinates] = useState<Coordinates>(null);
  const [passengerCount, setPassengerCount] = useState(1);
  const [rearSeat, setRearSeat] = useState(false);
  const [selections, setSelections] = useState<Record<string, string | boolean>>({});

  useEffect(() => {
    safeStorage((storage) => {
      const stored = storage.getItem(CUSTOMER_TOKEN_KEY);
      if (stored) setToken(stored);
      setPhone(storage.getItem(CUSTOMER_PHONE_KEY) ?? "");
    });
    const hour = new Date().getHours();
    setGreeting(hour >= 5 && hour < 12 ? "صباح الخير" : hour < 18 && hour >= 12 ? "يعطيك العافية" : "مساء الخير");
    void request<BookingConfig>("/booking/config")
      .then(setConfig)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "تعذر تحميل خيارات الحجز."))
      .finally(() => setLoading(false));
  }, []);

  const total = useMemo(() => {
    const options = config?.options ?? [];
    return (config?.basePriceJod ?? 0) +
      (rearSeat ? config?.rearSeatPriceJod ?? 0 : 0) +
      options.reduce((sum, option) => sum + (option.kind === "ADDON" && selections[option.id] === true ? option.priceJod : 0), 0);
  }, [config, rearSeat, selections]);

  const pickupLabel = pickupId === "other" ? pickupName : config?.locations.find((item) => item.id === pickupId)?.name ?? "";
  const destinationLabel = destinationId === "other" ? destinationName : config?.locations.find((item) => item.id === destinationId)?.name ?? "";
  const addonCount = (config?.options ?? []).filter((option) => option.kind === "ADDON" && selections[option.id] === true).length;

  function switchMode(mode: "login" | "register") {
    setAuthMode(mode);
    setError("");
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await request<{ token: string }>(`/auth/customer/${authMode}`, undefined, {
        method: "POST",
        body: JSON.stringify({ phone, password })
      });
      safeStorage((storage) => {
        storage.setItem(CUSTOMER_TOKEN_KEY, data.token);
        storage.setItem(CUSTOMER_PHONE_KEY, phone);
      });
      setToken(data.token);
      setPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تسجيل الدخول.");
    } finally {
      setBusy(false);
    }
  }

  function locate(onPick: (coordinates: Point) => void) {
    if (!navigator.geolocation) {
      setError("المتصفح لا يدعم تحديد الموقع. اختره على الخريطة أو اكتب العنوان.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        onPick({ latitude: coords.latitude, longitude: coords.longitude });
        setError("");
      },
      () => setError("تعذر تحديد موقعك. تحقق من صلاحية الوصول للموقع أو اختره على الخريطة."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function logout() {
    safeStorage((storage) => {
      storage.removeItem(CUSTOMER_TOKEN_KEY);
      storage.removeItem(CUSTOMER_PHONE_KEY);
    });
    setToken("");
    setNotice("");
    setError("");
    setAuthMode("login");
  }

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !token) return;
    setBusy(true);
    setError("");
    setNotice("");
    const selectedNames = config.options
      .filter((option) => selections[option.id] !== undefined && selections[option.id] !== false && selections[option.id] !== "")
      .map((option) => `${option.label}: ${selections[option.id] === true ? "نعم" : selections[option.id]}`)
      .join("\n");
    try {
      const result = await request<{ id: string; totalPriceJod: number; whatsappNumber: string }>("/customer/bookings", token, {
        method: "POST",
        body: JSON.stringify({
          pickupLocationId: pickupId !== "other" ? pickupId : undefined,
          pickupLocationName: pickupId === "other" ? pickupName : undefined,
          pickupAddress,
          pickupLatitude: pickupCoordinates?.latitude,
          pickupLongitude: pickupCoordinates?.longitude,
          destinationLocationId: destinationId !== "other" ? destinationId : undefined,
          destinationLocationName: destinationId === "other" ? destinationName : undefined,
          destinationAddress,
          destinationLatitude: destinationCoordinates?.latitude,
          destinationLongitude: destinationCoordinates?.longitude,
          passengerCount,
          rearSeat,
          selections
        })
      });
      const message = [
        "طلب حجز جديد - Take & Go",
        `رقم الطلب: ${result.id}`,
        phone ? `رقم العميل: ${phone}` : "",
        `من: ${pickupLabel} - ${pickupAddress}`,
        pickupCoordinates ? `خريطة الانطلاق: https://maps.google.com/?q=${pickupCoordinates.latitude},${pickupCoordinates.longitude}` : "",
        `إلى: ${destinationLabel} - ${destinationAddress}`,
        destinationCoordinates ? `خريطة الوجهة: https://maps.google.com/?q=${destinationCoordinates.latitude},${destinationCoordinates.longitude}` : "",
        `عدد الركاب: ${passengerCount}`,
        `المقعد الخلفي: ${rearSeat ? "نعم" : "لا"}`,
        selectedNames ? `الخدمات والحقول:\n${selectedNames}` : "",
        `السعر الإجمالي: ${money(result.totalPriceJod)}`
      ].filter(Boolean).join("\n");
      if (result.whatsappNumber) {
        window.location.assign(`https://wa.me/${result.whatsappNumber}?text=${encodeURIComponent(message)}`);
      } else {
        setNotice("تم حفظ طلبك، لكن رقم واتساب غير مضبوط حالياً. تواصل مع الإدارة لإرسال الطلب.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر حفظ طلب الحجز.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="page-loading">
        <span className="loading-star"><JordanStar size={34} /></span>
        <span>جارٍ تجهيز الحجز…</span>
      </main>
    );
  }

  /* ---------- Sign in / sign up ---------- */
  if (!token) {
    const isLogin = authMode === "login";
    return (
      <main className="auth-screen">
        <section className="auth-visual">
          <div className="auth-visual-top"><Brand light /></div>
          <div className="auth-visual-copy">
            <h1>مشوارك علينا،<br /><em>من الباب للباب.</em></h1>
            <p>سيارة خاصة، سعر واضح قبل ما تحجز، وطلبك بيوصلنا فوراً على واتساب.</p>
          </div>
          <Skyline className="skyline" />
        </section>

        <section className="auth-panel">
          <form className="auth-card" onSubmit={authenticate}>
            <div className="shemagh-strip" aria-hidden="true" />
            <div className="auth-card-body">
              <h2>{isLogin ? "هلا والله، نوّرت من جديد" : "يا هلا فيك"}</h2>
              <p className="auth-intro">{isLogin ? "ادخل برقم هاتفك وكلمة المرور وكمّل حجزك." : "حساب جديد برقم هاتفك بثواني، وبتقدر تحجز على طول."}</p>

              <div className="segmented" role="tablist" aria-label="نوع الدخول">
                <button type="button" role="tab" aria-selected={!isLogin} className={!isLogin ? "active" : ""} onClick={() => switchMode("register")}>حساب جديد</button>
                <button type="button" role="tab" aria-selected={isLogin} className={isLogin ? "active" : ""} onClick={() => switchMode("login")}>تسجيل الدخول</button>
              </div>

              <label className="field">
                <span className="field-label">رقم الهاتف</span>
                <span className="input-shell has-icon">
                  <Phone size={18} className="input-icon" />
                  <input className="ltr-input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="07X XXX XXXX" required minLength={8} maxLength={24} />
                </span>
              </label>

              <label className="field">
                <span className="field-label">كلمة المرور</span>
                <span className="input-shell has-icon">
                  <Lock size={18} className="input-icon" />
                  <input
                    type={showPassword ? "text" : "password"}
                    autoComplete={isLogin ? "current-password" : "new-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={isLogin ? "كلمة المرور" : "٦ أحرف على الأقل"}
                    required
                    minLength={isLogin ? 1 : 6}
                    maxLength={128}
                  />
                  <button type="button" className="icon-button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}>
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </span>
              </label>

              {error && <p className="alert alert-error" role="alert">{error}</p>}

              <button className="primary-button full" disabled={busy}>
                {busy ? <><span className="button-spinner" /> لحظة من فضلك…</> : <>{isLogin ? "دخول" : "أنشئ حسابي وابدأ"} <ArrowLeft size={18} /></>}
              </button>

              <div className="trust-row">
                <span><ShieldCheck size={15} /> بياناتك بأمان</span>
                <span><CarFront size={15} /> سيارات خاصة</span>
                <span><MessageCircle size={15} /> تأكيد عبر واتساب</span>
              </div>
            </div>
          </form>
        </section>
      </main>
    );
  }

  /* ---------- Booking ---------- */
  return (
    <main className="app-shell">
      <header className="app-bar">
        <Brand />
        <div className="app-bar-actions">
          {phone && <span className="user-chip ltr-input">{phone}</span>}
          <button className="icon-text-button" type="button" onClick={logout}><LogOut size={16} /> <span>خروج</span></button>
        </div>
      </header>

      <section className="welcome">
        <div className="welcome-copy">
          <span className="pill pill-soft"><JordanStar size={12} /> {greeting}</span>
          <h1>وين وجهتك اليوم؟</h1>
          <p>ثلاث خطوات بسيطة وبتوصلنا تفاصيل مشوارك على واتساب.</p>
        </div>
        <Skyline className="welcome-skyline" />
      </section>

      {!config ? (
        <section className="card empty-card">
          <p className="alert alert-error" role="alert">{error || "تعذر تحميل إعدادات الحجز."}</p>
          <button className="secondary-button" onClick={() => window.location.reload()}>إعادة المحاولة</button>
        </section>
      ) : (
        <div className="booking-layout">
          <form id="booking-form" className="booking-steps" onSubmit={submitBooking}>
            {error && <p className="alert alert-error" role="alert">{error}</p>}
            {notice && <p className="alert alert-success" role="status">{notice}</p>}
            {!config.whatsappNumber && <p className="alert alert-error" role="status">لا يمكن إرسال الحجز حالياً لأن الإدارة لم تضبط رقم واتساب بعد.</p>}

            <section className="card">
              <header className="card-head">
                <span className="step-number">١</span>
                <div><h2>المسار</h2><p>من وين بنمرق عليك، ولوين رايح؟</p></div>
              </header>
              <div className="route">
                <StopField kind="from" title="نقطة الانطلاق" locations={config.locations} locationId={pickupId} onLocationChange={setPickupId} customName={pickupName} onCustomNameChange={setPickupName} address={pickupAddress} onAddressChange={setPickupAddress} coordinates={pickupCoordinates} onCoordinatesChange={setPickupCoordinates} onLocate={() => locate(setPickupCoordinates)} />
                <StopField kind="to" title="الوجهة" locations={config.locations} locationId={destinationId} onLocationChange={setDestinationId} customName={destinationName} onCustomNameChange={setDestinationName} address={destinationAddress} onAddressChange={setDestinationAddress} coordinates={destinationCoordinates} onCoordinatesChange={setDestinationCoordinates} onLocate={() => locate(setDestinationCoordinates)} />
              </div>
            </section>

            <section className="card">
              <header className="card-head">
                <span className="step-number">٢</span>
                <div><h2>الركاب</h2><p>كم شخص معك؟</p></div>
              </header>
              <div className="option-row">
                <span className="option-icon"><Users size={19} /></span>
                <span className="option-text"><strong>عدد الركاب</strong><small>حتى {MAX_PASSENGERS} ركاب</small></span>
                <div className="stepper" role="group" aria-label="عدد الركاب">
                  <button type="button" onClick={() => setPassengerCount((count) => Math.min(MAX_PASSENGERS, count + 1))} disabled={passengerCount >= MAX_PASSENGERS} aria-label="زيادة"><Plus size={16} /></button>
                  <output aria-live="polite">{passengerCount}</output>
                  <button type="button" onClick={() => setPassengerCount((count) => Math.max(1, count - 1))} disabled={passengerCount <= 1} aria-label="إنقاص"><Minus size={16} /></button>
                </div>
              </div>
              <label className="option-row selectable">
                <span className="option-icon"><Armchair size={19} /></span>
                <span className="option-text"><strong>المقعد الخلفي</strong><small>+ {money(config.rearSeatPriceJod)}</small></span>
                <input className="switch" type="checkbox" checked={rearSeat} onChange={(event) => setRearSeat(event.target.checked)} />
              </label>
            </section>

            {config.options.length > 0 && (
              <section className="card">
                <header className="card-head">
                  <span className="step-number">٣</span>
                  <div><h2>إضافات</h2><p>اختار اللي بتحتاجه، والسعر بيتحدث مباشرة.</p></div>
                </header>
                <div className="options-list">
                  {config.options.map((option) => option.kind === "ADDON" ? (
                    <label key={option.id} className="option-row selectable">
                      <span className="option-icon"><Sparkles size={18} /></span>
                      <span className="option-text"><strong>{option.label}{option.required && <em className="required-tag">مطلوب</em>}</strong><small>+ {money(option.priceJod)}</small></span>
                      <input className="switch" type="checkbox" checked={selections[option.id] === true} onChange={(event) => setSelections((values) => ({ ...values, [option.id]: event.target.checked }))} required={option.required} />
                    </label>
                  ) : (
                    <label key={option.id} className="field">
                      <span className="field-label">{option.label}{option.required && <em className="required-tag">مطلوب</em>}</span>
                      <span className="input-shell">
                        <input value={typeof selections[option.id] === "string" ? selections[option.id] as string : ""} onChange={(event) => setSelections((values) => ({ ...values, [option.id]: event.target.value }))} required={option.required} maxLength={300} />
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )}
          </form>

          <aside className="summary" aria-label="ملخص الحجز">
            <div className="summary-card">
              <div className="shemagh-strip" aria-hidden="true" />
              <div className="summary-body">
                <h3 className="summary-title">ملخص المشوار</h3>
                <ul className="summary-route">
                  <li className="from"><small>من</small><span>{pickupLabel || "—"}</span></li>
                  <li className="to"><small>إلى</small><span>{destinationLabel || "—"}</span></li>
                </ul>
                <dl className="summary-lines">
                  <div><dt>الركاب</dt><dd>{passengerCount}</dd></div>
                  <div><dt>المقعد الخلفي</dt><dd>{rearSeat ? "نعم" : "لا"}</dd></div>
                  {addonCount > 0 && <div><dt>إضافات</dt><dd>{addonCount}</dd></div>}
                </dl>
                <div className="summary-footer">
                  <div className="total">
                    <small>المجموع التقديري</small>
                    <strong>{money(total)}</strong>
                  </div>
                  <button form="booking-form" className="whatsapp-button" disabled={busy || !config.whatsappNumber}>
                    {busy ? <><span className="button-spinner" /> جارٍ الحفظ…</> : <><MessageCircle size={19} /> أرسل عبر واتساب</>}
                  </button>
                </div>
                <p className="summary-note">بنحفظ طلبك أولاً، بعدين بنفتح واتساب لترسله لفريقنا. الطلب لا يعيّن سائقاً تلقائياً.</p>
              </div>
            </div>
          </aside>
        </div>
      )}

      <footer className="page-footer">
        <span className="footer-brand"><JordanStar size={12} /> صُنع بحب في الأردن</span>
        <span>© Take &amp; Go</span>
      </footer>
    </main>
  );
}
