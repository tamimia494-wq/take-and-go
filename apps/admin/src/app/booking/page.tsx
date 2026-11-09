"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, MapPin, Plus, Save, Trash2, Users } from "lucide-react";
import styles from "./booking.module.css";
import { amountInput, blankZero } from "../amount";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const API = API_URL.endsWith("/api") ? API_URL : `${API_URL.replace(/\/$/, "")}/api`;
type Location = { id: string; name: string; active: boolean; sortOrder: number };
// priceJod is a string while the admin is typing in an edited row.
type Option = { id: string; label: string; kind: "ADDON" | "FIELD"; priceJod: number | string; required: boolean; active: boolean; sortOrder: number };
type Settings = { basePriceJod: number; rearSeatPriceJod: number; whatsappNumber: string };
type SettingsForm = { basePriceJod: string; rearSeatPriceJod: string; whatsappNumber: string };

type Booking = {
  id: string;
  customerPhone: string;
  pickupLocation: string;
  pickupAddress: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  destinationLocation: string;
  destinationAddress: string;
  destinationLatitude: number | null;
  destinationLongitude: number | null;
  passengerCount: number;
  rearSeat: boolean;
  selections: Record<string, { label: string; kind: string; value: string | boolean; priceFils: number }>;
  totalPriceJod: number;
  createdAt: string;
};
type BookingAdminData = { settings: Settings; locations: Location[]; options: Option[] };
type Customer = { id: string; phone: string; createdAt: string; lockedUntil: string | null; bookingCount: number };

/** 962791234567 → 0791234567 */
function localPhone(phone: string): string {
  return phone.startsWith("962") ? `0${phone.slice(3)}` : phone;
}

async function api<T>(path: string, token: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const text = await response.text();
  let result: { error?: string } & Record<string, unknown>;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`تعذر قراءة رد الخادم (${response.status}).`);
  }
  if (!response.ok) throw new Error(result.error ?? `تعذر إكمال الطلب (${response.status}).`);
  return result as T;
}

function money(value: number): string {
  return `${new Intl.NumberFormat("ar-JO", { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(value)} د.أ`;
}

export default function BookingAdminPage() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<BookingAdminData | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [settings, setSettings] = useState<SettingsForm>({ basePriceJod: "", rearSeatPriceJod: "", whatsappNumber: "" });
  const [locationName, setLocationName] = useState("");
  const [option, setOption] = useState({ label: "", kind: "ADDON" as "ADDON" | "FIELD", priceJod: "", required: false });
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (authToken: string) => {
    const [config, bookingList, customerList] = await Promise.all([
      api<BookingAdminData>("/admin/booking/config", authToken),
      api<Booking[]>("/admin/bookings", authToken),
      api<Customer[]>("/admin/booking/customers", authToken)
    ]);
    setData(config);
    setSettings({
      basePriceJod: blankZero(config.settings.basePriceJod),
      rearSeatPriceJod: blankZero(config.settings.rearSeatPriceJod),
      whatsappNumber: config.settings.whatsappNumber
    });
    setBookings(bookingList);
    setCustomers(customerList);
  }, []);

  function deleteCustomer(customer: Customer) {
    const phone = localPhone(customer.phone);
    const warning = customer.bookingCount > 0
      ? `حذف حساب ${phone} نهائياً مع ${customer.bookingCount} من طلبات الحجز الخاصة به؟ لا يمكن التراجع.`
      : `حذف حساب ${phone} نهائياً؟ يستطيع صاحب الرقم إنشاء حساب جديد بعدها.`;
    if (!window.confirm(warning)) return;
    void perform(async () => { await api(`/admin/booking/customers/${customer.id}`, token, "DELETE"); }, `تم حذف حساب ${phone}. يستطيع صاحبه إنشاء حساب جديد الآن.`);
  }

  const searchDigits = customerSearch.replace(/\D/g, "").replace(/^0/, "");
  const visibleCustomers = searchDigits ? customers.filter((customer) => customer.phone.includes(searchDigits)) : customers;

  useEffect(() => {
    const stored = window.localStorage.getItem("take-go-admin-token");
    if (!stored) {
      setError("سجّل الدخول من لوحة الإدارة أولاً.");
      return;
    }
    setToken(stored);
    void refresh(stored).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "تعذر تحميل بيانات الحجوزات."));
  }, [refresh]);

  async function perform(action: () => Promise<void>, successMessage: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(successMessage);
      if (token) await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تنفيذ الطلب.");
    } finally {
      setBusy(false);
    }
  }

  function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => { await api("/admin/booking/settings", token, "PUT", settings); }, "تم حفظ إعدادات الحجز.");
  }

  function addLocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => {
      await api("/admin/booking/locations", token, "POST", { name: locationName, sortOrder: data?.locations.length ?? 0 });
      setLocationName("");
    }, "تمت إضافة الموقع.");
  }

  function updateLocation(location: Location, changes: Partial<Location>) {
    const updated = { ...location, ...changes };
    void perform(async () => {
      await api(`/admin/booking/locations/${location.id}`, token, "PATCH", updated);
    }, "تم تحديث الموقع.");
  }

  function addOption(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => {
      await api("/admin/booking/options", token, "POST", {
        ...option,
        priceJod: option.kind === "ADDON" ? option.priceJod || "0" : "0",
        active: true,
        sortOrder: data?.options.length ?? 0
      });
      setOption({ label: "", kind: "ADDON", priceJod: "", required: false });
    }, "تمت إضافة الخيار.");
  }

  function saveOption(item: Option) {
    void perform(async () => {
      await api(`/admin/booking/options/${item.id}`, token, "PATCH", {
        label: item.label,
        kind: item.kind,
        priceJod: String(item.priceJod) || "0",
        required: item.required,
        active: item.active,
        sortOrder: item.sortOrder
      });
      setEditing(null);
    }, "تم تحديث الخيار.");
  }

  if (!token) {
    return <main className={styles.page}><div className={styles.message}><h1>إدارة الحجوزات</h1><p>{error || "جارٍ التحقق من جلسة الإدارة..."}</p><a className={styles.button} href="/">العودة إلى لوحة الإدارة</a></div></main>;
  }

  return (
    <main className={styles.page} dir="rtl">
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>Take &amp; Go</p><h1>إدارة الحجوزات</h1><p>ضبط المواقع والخدمات والأسعار ومراجعة الطلبات المحفوظة.</p></div>
        <a className={styles.linkButton} href="/"><ArrowRight size={16} /> لوحة الإدارة</a>
      </header>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {!data ? <div className={styles.message}>جارٍ تحميل الإعدادات...</div> : <>
        <form className={styles.panel} onSubmit={saveSettings}>
          <div className={styles.panelTitle}><div><h2>إعدادات السعر والتواصل</h2><p>تُحسب الأسعار من هذه القيم على الخادم.</p></div><Save size={20} /></div>
          <div className={styles.settingsGrid}>
            <label>سعر السيارة (د.أ) — خيار يختاره العميل<input type="text" inputMode="decimal" dir="ltr" value={settings.basePriceJod} onChange={(event) => setSettings({ ...settings, basePriceJod: amountInput(event.target.value) })} placeholder="مثلاً 15" /></label>
            <label>سعر المقعد الخلفي (د.أ)<input type="text" inputMode="decimal" dir="ltr" value={settings.rearSeatPriceJod} onChange={(event) => setSettings({ ...settings, rearSeatPriceJod: amountInput(event.target.value) })} placeholder="مثلاً 12" /></label>
            <label>رقم واتساب<input type="tel" dir="ltr" value={settings.whatsappNumber} onChange={(event) => setSettings({ ...settings, whatsappNumber: event.target.value })} placeholder="079xxxxxxx" required minLength={8} maxLength={24} /></label>
          </div>
          <button className={styles.button} disabled={busy}><Save size={15} /> حفظ الإعدادات</button>
        </form>

        <section className={styles.twoColumns}>
          <article className={styles.panel}>
            <div className={styles.panelTitle}><div><h2>أماكن الانطلاق والوجهة</h2><p>إضافة المواقع المعروضة في صفحة الحجز.</p></div><MapPin size={20} /></div>
            <form className={styles.addRow} onSubmit={addLocation}><input value={locationName} onChange={(event) => setLocationName(event.target.value)} placeholder="اسم الموقع" minLength={2} maxLength={120} required /><button className={styles.iconButton} disabled={busy} aria-label="إضافة الموقع"><Plus size={17} /></button></form>
            <div className={styles.list}>{data.locations.map((location) => <div className={styles.listRow} key={location.id}>
              <input aria-label="اسم الموقع" value={location.name} onChange={(event) => setData({ ...data, locations: data.locations.map((item) => item.id === location.id ? { ...item, name: event.target.value } : item) })} />
              <button className={location.active ? styles.toggleActive : styles.toggleOff} disabled={busy} onClick={() => updateLocation(location, { active: !location.active })}>{location.active ? "مفعّل" : "متوقف"}</button>
              <button className={styles.iconButton} disabled={busy} onClick={() => updateLocation(data.locations.find((item) => item.id === location.id) ?? location, {})} aria-label="حفظ الموقع"><Check size={16} /></button>
              <button className={styles.deleteButton} disabled={busy} onClick={() => void perform(async () => { await api(`/admin/booking/locations/${location.id}`, token, "DELETE"); }, "تم حذف الموقع.")} aria-label="حذف الموقع"><Trash2 size={15} /></button>
            </div>)}</div>
          </article>
          <article className={styles.panel}>
            <div className={styles.panelTitle}><div><h2>الخدمات والحقول الإضافية</h2><p>الخدمات تضيف سعراً ثابتاً، والحقول تحفظ معلومة نصية.</p></div><Plus size={20} /></div>
            <form className={styles.optionForm} onSubmit={addOption}>
              <label>الاسم<input value={option.label} onChange={(event) => setOption({ ...option, label: event.target.value })} required minLength={2} maxLength={120} /></label>
              <label>النوع<select value={option.kind} onChange={(event) => setOption({ ...option, kind: event.target.value as "ADDON" | "FIELD" })}><option value="ADDON">خدمة بسعر</option><option value="FIELD">حقل نصي</option></select></label>
              {option.kind === "ADDON" && <label>السعر (د.أ)<input type="text" inputMode="decimal" dir="ltr" value={option.priceJod} onChange={(event) => setOption({ ...option, priceJod: amountInput(event.target.value) })} placeholder="مثلاً 5" required /></label>}
              <label className={styles.checkboxLabel}><input type="checkbox" checked={option.required} onChange={(event) => setOption({ ...option, required: event.target.checked })} /> مطلوب</label>
              <button className={styles.iconButton} disabled={busy} aria-label="إضافة الخيار"><Plus size={17} /></button>
            </form>
            <div className={styles.list}>{data.options.map((item) => <div className={styles.optionRow} key={item.id}>
              {editing === item.id ? <>
                <input value={item.label} onChange={(event) => setData({ ...data, options: data.options.map((value) => value.id === item.id ? { ...value, label: event.target.value } : value) })} />
                <select value={item.kind} onChange={(event) => setData({ ...data, options: data.options.map((value) => value.id === item.id ? { ...value, kind: event.target.value as "ADDON" | "FIELD" } : value) })}><option value="ADDON">خدمة</option><option value="FIELD">حقل</option></select>
                {item.kind === "ADDON" && <input aria-label="السعر" type="text" inputMode="decimal" dir="ltr" value={blankZero(item.priceJod)} placeholder="السعر" onChange={(event) => setData({ ...data, options: data.options.map((value) => value.id === item.id ? { ...value, priceJod: amountInput(event.target.value) } : value) })} />}
                <label className={styles.checkboxLabel}><input type="checkbox" checked={item.required} onChange={(event) => setData({ ...data, options: data.options.map((value) => value.id === item.id ? { ...value, required: event.target.checked } : value) })} /> مطلوب</label>
                <button className={styles.iconButton} onClick={() => saveOption(item)} disabled={busy} aria-label="حفظ الخيار"><Check size={16} /></button>
              </> : <>
                <button className={styles.optionName} onClick={() => setEditing(item.id)}>{item.label}</button>
                <span>{item.kind === "ADDON" ? money(Number(item.priceJod)) : "حقل نصي"}</span>
                <button className={item.active ? styles.toggleActive : styles.toggleOff} disabled={busy} onClick={() => saveOption({ ...item, active: !item.active })}>{item.active ? "مفعّل" : "متوقف"}</button>
                <button className={styles.deleteButton} disabled={busy} onClick={() => void perform(async () => { await api(`/admin/booking/options/${item.id}`, token, "DELETE"); }, "تم حذف الخيار.")} aria-label="حذف الخيار"><Trash2 size={15} /></button>
              </>}
            </div>)}</div>
          </article>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}><div><h2>حسابات العملاء ({customers.length})</h2><p>كلمات المرور محفوظة مشفّرة ولا يمكن عرضها. إذا نسي العميل كلمة المرور احذف حسابه ليُنشئ حساباً جديداً بنفس الرقم.</p></div><Users size={20} /></div>
          <div className={styles.addRow}><input type="search" dir="ltr" value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} placeholder="ابحث برقم الهاتف 07xxxxxxxx" aria-label="ابحث برقم الهاتف" /></div>
          {visibleCustomers.length === 0 ? <p className={styles.empty}>{customers.length === 0 ? "لا توجد حسابات عملاء حتى الآن." : "لا يوجد حساب بهذا الرقم."}</p> : <div className={styles.list}>{visibleCustomers.map((customer) => (
            <div className={styles.customerRow} key={customer.id}>
              <bdi className={styles.customerPhone}>{localPhone(customer.phone)}</bdi>
              <span>{customer.bookingCount} طلب</span>
              <span>{new Date(customer.createdAt).toLocaleDateString("ar-JO")}</span>
              {customer.lockedUntil && new Date(customer.lockedUntil) > new Date() && <span className={styles.lockedTag}>مقفل مؤقتاً</span>}
              <button className={styles.deleteButton} disabled={busy} onClick={() => deleteCustomer(customer)} aria-label={`حذف حساب ${localPhone(customer.phone)}`}><Trash2 size={15} /></button>
            </div>
          ))}</div>}
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}><div><h2>طلبات الحجز ({bookings.length})</h2><p>آخر 200 طلب محفوظ في قاعدة البيانات.</p></div><button className={styles.linkButton} onClick={() => void perform(async () => {}, "تم تحديث القائمة.")}>تحديث</button></div>
          {bookings.length === 0 ? <p className={styles.empty}>لا توجد طلبات حجز حتى الآن.</p> : <div className={styles.bookings}>{bookings.map((booking) => (
            <article className={styles.booking} key={booking.id}>
              <div className={styles.bookingTop}><strong>{booking.pickupLocation} ← {booking.destinationLocation}</strong><span>{money(booking.totalPriceJod)}</span></div>
              <div className={styles.bookingMeta}><span>هاتف العميل: <bdi>{booking.customerPhone}</bdi></span><span>{new Date(booking.createdAt).toLocaleString("ar-JO")}</span></div>
              <p>{booking.pickupAddress} → {booking.destinationAddress}</p>
              <div className={styles.bookingMeta}><span>{booking.passengerCount} ركاب</span><span>المقعد الخلفي: {booking.rearSeat ? "نعم" : "لا"}</span><span>سيارة: {booking.selections.car ? "نعم" : "لا"}</span></div>
              {Object.keys(booking.selections).length > 0 && <p>{Object.values(booking.selections).map((selection) =>
                `${selection.label}: ${selection.value === true ? "نعم" : selection.value === false ? "لا" : selection.value}`
              ).join("، ")}</p>}
              {(booking.pickupLatitude !== null || booking.destinationLatitude !== null) && <div className={styles.bookingMeta}>
                {booking.pickupLatitude !== null && <a target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${booking.pickupLatitude}&mlon=${booking.pickupLongitude}#map=16/${booking.pickupLatitude}/${booking.pickupLongitude}`}>موقع الانطلاق على الخريطة</a>}
                {booking.destinationLatitude !== null && <a target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${booking.destinationLatitude}&mlon=${booking.destinationLongitude}#map=16/${booking.destinationLatitude}/${booking.destinationLongitude}`}>موقع الوجهة على الخريطة</a>}
              </div>}
            </article>
          ))}</div>}
        </section>
      </>}
    </main>
  );
}
