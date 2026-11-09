"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import {
  Armchair,
  Check,
  ChevronDown,
  Clock3,
  LocateFixed,
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

/** In production NEXT_PUBLIC_API_URL is set; in development fall back to port 4000 on whatever host served the page. */
function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  const url = configured || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:4000/api` : "http://localhost:4000/api");
  return url.endsWith("/api") ? url : `${url.replace(/\/$/, "")}/api`;
}

const PHONE_KEY = "take-go-customer-phone";
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  } catch (reason) {
    if (reason instanceof TypeError) {
      const cause = typeof navigator !== "undefined" && !navigator.onLine
        ? "لا يوجد اتصال بالإنترنت على هذا الجهاز"
        : `الخادم لم يرد (${apiBase()}) — ${reason.message}`;
      throw new Error(`تعذر الاتصال بخدمة الحجز. السبب: ${cause}. تحقق من الاتصال ثم أعد المحاولة.`);
    }
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
    /* storage blocked (private mode): the phone simply isn't remembered */
  }
}

const STAR_POINTS = Array.from({ length: 14 }, (_, index) => {
  const radius = index % 2 === 0 ? 2.4 : 1.1;
  const angle = -Math.PI / 2 + (index * Math.PI) / 7;
  return `${(7.2 + radius * Math.cos(angle)).toFixed(2)},${(10 + radius * Math.sin(angle)).toFixed(2)}`;
}).join(" ");

/** Drawn flag: emoji flags render as plain letters on Windows. */
function JordanFlag() {
  return (
    <svg className="flag" width="27" height="18" viewBox="0 0 30 20" aria-label="الأردن" role="img">
      <rect width="30" height="6.67" fill="#000" />
      <rect y="6.67" width="30" height="6.67" fill="#fff" />
      <rect y="13.33" width="30" height="6.67" fill="#007a3d" />
      <path d="M0 0 L15 10 L0 20 Z" fill="#ce1126" />
      <polygon points={STAR_POINTS} fill="#fff" />
    </svg>
  );
}

/** The Take & go mark, same as on the captain site. */
function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`logo${compact ? " logo-compact" : ""}`} aria-label="Take & go">
      <span className="logo-tg">T<span className="logo-g">G</span><span className="logo-pin" aria-hidden="true">📍</span></span>
      <span className="logo-name">Take<b>&amp;</b>go</span>
    </div>
  );
}

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
                <input value={customName} onChange={(event) => onCustomNameChange(event.target.value)} placeholder="مثلاً: جبل عمّان، الصويفية، إربد" required minLength={2} maxLength={120} />
              </span>
            </label>
          )}
          <label className="field field-wide">
            <span className="field-label">العنوان بالتفصيل</span>
            <span className="input-shell">
              <input value={address} onChange={(event) => onAddressChange(event.target.value)} placeholder="الشارع، العمارة، أو أقرب معلم معروف" required minLength={2} maxLength={300} />
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

export default function BookingPage() {
  const [config, setConfig] = useState<BookingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [phone, setPhone] = useState("");
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
    safeStorage((storage) => setPhone(storage.getItem(PHONE_KEY) ?? ""));
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
  const stepCount = config && config.options.length > 0 ? 4 : 3;

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
      () => setError("تعذر تحديد موقعك. اسمح للمتصفح بالوصول للموقع أو اختره على الخريطة."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config) return;
    setBusy(true);
    setError("");
    setNotice("");
    const selectedNames = config.options
      .filter((option) => selections[option.id] !== undefined && selections[option.id] !== false && selections[option.id] !== "")
      .map((option) => `${option.label}: ${selections[option.id] === true ? "نعم" : selections[option.id]}`)
      .join("\n");
    try {
      const result = await request<{ id: string; totalPriceJod: number; whatsappNumber: string }>("/booking/requests", {
        method: "POST",
        body: JSON.stringify({
          phone,
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
      safeStorage((storage) => storage.setItem(PHONE_KEY, phone));
      const message = [
        "طلب حجز جديد - Take & go",
        `رقم الطلب: ${result.id}`,
        `رقم العميل: ${phone}`,
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
        setNotice("تم حفظ طلبك، لكن رقم واتساب غير مضبوط حالياً. سنتواصل معك على رقمك.");
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
        <Logo compact />
        <span className="loading-bar" aria-hidden="true"><span /></span>
        <span>جارٍ تجهيز الحجز…</span>
      </main>
    );
  }

  return (
    <main className="app">
      <section className="hero">
        <div className="hero-inner">
          <Logo />
          <span className="hero-tagline">معك في كل طريق <JordanFlag /></span>
          <h1>وين رايح اليوم؟</h1>
          <p>احجز مشوارك بدقيقة: حدّد الطريق، شوف السعر، وابعث طلبك على واتساب.</p>
          <div className="hero-chips">
            <span><ShieldCheck size={14} /> سيارة خاصة</span>
            <span><Clock3 size={14} /> بدون تسجيل دخول</span>
            <span><MessageCircle size={14} /> تأكيد عبر واتساب</span>
          </div>
        </div>
      </section>

      {!config ? (
        <section className="card empty-card">
          <p className="alert alert-error" role="alert">{error || "تعذر تحميل إعدادات الحجز."}</p>
          <button className="gold-button" onClick={() => window.location.reload()}>إعادة المحاولة</button>
        </section>
      ) : (
        <div className="layout">
          <form id="booking-form" className="steps" onSubmit={submitBooking}>
            {!config.whatsappNumber && <p className="alert alert-warn" role="status">الحجز متوقف مؤقتاً لأن الإدارة لم تضبط رقم واتساب بعد.</p>}

            <section className="card">
              <header className="card-head">
                <span className="step-number">1</span>
                <div><h2>المسار</h2><p>من وين بنمرق عليك، ولوين رايح؟</p></div>
              </header>
              <div className="route">
                <StopField kind="from" title="نقطة الانطلاق" locations={config.locations} locationId={pickupId} onLocationChange={setPickupId} customName={pickupName} onCustomNameChange={setPickupName} address={pickupAddress} onAddressChange={setPickupAddress} coordinates={pickupCoordinates} onCoordinatesChange={setPickupCoordinates} onLocate={() => locate(setPickupCoordinates)} />
                <StopField kind="to" title="الوجهة" locations={config.locations} locationId={destinationId} onLocationChange={setDestinationId} customName={destinationName} onCustomNameChange={setDestinationName} address={destinationAddress} onAddressChange={setDestinationAddress} coordinates={destinationCoordinates} onCoordinatesChange={setDestinationCoordinates} onLocate={() => locate(setDestinationCoordinates)} />
              </div>
            </section>

            <section className="card">
              <header className="card-head">
                <span className="step-number">2</span>
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
                  <span className="step-number">3</span>
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

            <section className="card">
              <header className="card-head">
                <span className="step-number">{stepCount}</span>
                <div><h2>رقم هاتفك</h2><p>عشان يتواصل معك الكابتن ويأكد مشوارك.</p></div>
              </header>
              <label className="field">
                <span className="field-label">رقم الهاتف</span>
                <span className="input-shell has-icon">
                  <Phone size={18} className="input-icon" />
                  <input className="ltr-input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="07X XXX XXXX" required minLength={10} maxLength={24} />
                </span>
              </label>
            </section>

            {error && <p className="alert alert-error" role="alert">{error}</p>}
            {notice && <p className="alert alert-success" role="status">{notice}</p>}
          </form>

          <aside className="summary" aria-label="ملخص الحجز">
            <div className="summary-card">
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
                <button form="booking-form" className="gold-button submit-button" disabled={busy || !config.whatsappNumber}>
                  {busy ? <><span className="button-spinner" /> جارٍ الإرسال…</> : <><MessageCircle size={19} /> احجز عبر واتساب</>}
                </button>
              </div>
              <p className="summary-note">بنحفظ طلبك وبعدين بنفتح واتساب لترسله لفريقنا.</p>
            </div>
          </aside>
        </div>
      )}

      <footer className="page-footer">Take &amp;go <span>·</span> معك في كل طريق</footer>
    </main>
  );
}
