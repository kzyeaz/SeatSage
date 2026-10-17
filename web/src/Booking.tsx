import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  LockKeyhole,
  MapPin,
  ShieldCheck,
  Ticket,
  TriangleAlert,
} from "lucide-react";
import { api, ApiError, eventDate, money } from "./api";
import type { Event, Hold, Order, Seat } from "./types";
import Modal from "./Modal";

export function Receipt({
  order,
  onClose,
  onTickets,
}: {
  order: Order;
  onClose: () => void;
  onTickets?: () => void;
}) {
  const download = () => {
    const content = [
      "SEATSAGE — DEMO TICKET (not valid for admission)",
      "",
      order.event.title,
      `${order.event.venue}, ${order.event.city}`,
      eventDate(order.event.starts_at, order.event.city, {
        dateStyle: "full",
        timeStyle: "short",
        month: undefined,
        day: undefined,
      }),
      `Seats: ${order.seats.map((s) => `${s.id} (${s.section})`).join(", ")}`,
      `Order: ${order.id}`,
      `Total: ${money(order.total_cents, true)}`,
      "",
      "Simulated payment. No money was charged.",
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/plain" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${order.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Modal
      onClose={onClose}
      label="Your booking is confirmed"
      className="receipt-modal"
    >
      <div className="success-icon">
        <Check size={30} />
      </div>
      <span className="eyebrow">YOU’RE GOING</span>
      <h2>A great night, secured.</h2>
      <p className="muted">
        Your seats are booked. Let the anticipation begin.
      </p>
      <div className="receipt-ticket">
        <img src={order.event.image} alt="" />
        <div className="receipt-ticket-content">
          <span className="category-label">
            {order.event.category} · DEMO TICKET
          </span>
          <h3>{order.event.title}</h3>
          <p>
            {eventDate(order.event.starts_at, order.event.city, {
              weekday: "short",
            })}{" "}
            ·{" "}
            {eventDate(order.event.starts_at, order.event.city, {
              hour: "numeric",
              minute: "2-digit",
              month: undefined,
              day: undefined,
            })}
          </p>
          <p>
            {order.event.venue} · {order.event.city}
          </p>
          <div className="ticket-perforation" />
          <div className="ticket-facts">
            <div>
              <span>YOUR SEATS</span>
              <strong>{order.seats.map((s) => s.id).join(", ")}</strong>
            </div>
            <div>
              <span>TOTAL</span>
              <strong>{money(order.total_cents, true)}</strong>
            </div>
          </div>
          <p className="order-reference">{order.id}</p>
        </div>
      </div>
      <p className="demo-note">
        <ShieldCheck size={15} /> Demo booking. No payment was collected.
      </p>
      <button className="button primary full" onClick={download}>
        <Download size={17} /> Download demo ticket
      </button>
      {onTickets && (
        <button className="text-button receipt-link" onClick={onTickets}>
          Go to my tickets <ArrowRight size={16} />
        </button>
      )}
    </Modal>
  );
}

export default function Booking({
  event,
  onClose,
  onBooked,
}: {
  event: Event;
  onClose: () => void;
  onBooked: (order: Order) => void;
}) {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [hold, setHold] = useState<Hold | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [key, setKey] = useState("");
  const deadline = useRef(0);
  const refresh = async () => {
    const result = await api<{ seats: Seat[] }>(`/events/${event.id}/seats`);
    setSeats(result.seats);
    return result.seats;
  };
  useEffect(() => {
    let active = true;
    const load = () =>
      api<{ seats: Seat[] }>(`/events/${event.id}/seats`)
        .then((data) => {
          if (active) setSeats(data.seats);
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    void load();
    const interval = window.setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [event.id]);
  useEffect(() => {
    if (!hold && !busy) {
      setSelected((current) =>
        current.filter((id) =>
          seats.some((seat) => seat.id === id && seat.status === "available"),
        ),
      );
    }
  }, [seats, hold, busy]);
  useEffect(() => {
    if (!hold) return;
    const tick = () => {
      const seconds = Math.max(
        0,
        Math.ceil((deadline.current - Date.now()) / 1000),
      );
      setRemaining(seconds);
      if (seconds === 0) {
        setHold(null);
        setSelected([]);
        setAgreed(false);
        setError(
          "Your hold expired. Choose your seats again to start a fresh reservation.",
        );
        void refresh().catch(() => {});
      }
    };
    tick();
    const interval = window.setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [hold]);
  const selectedSeats = seats.filter((s) => selected.includes(s.id));
  const subtotal =
    hold?.subtotal_cents ??
    selectedSeats.reduce((n, s) => n + s.price_cents, 0);
  const fee = Math.floor((subtotal * 8 + 50) / 100);
  const toggle = (seat: Seat) => {
    setError("");
    if (selected.includes(seat.id))
      setSelected(selected.filter((id) => id !== seat.id));
    else if (selected.length < 6) setSelected([...selected, seat.id]);
    else setError("You can book up to 6 seats at a time.");
  };
  const reserve = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<Hold>("/holds", {
        method: "POST",
        body: JSON.stringify({ event_id: event.id, seat_ids: selected }),
      });
      deadline.current =
        Date.now() + (result.expires_at - result.server_time) * 1000;
      setRemaining(result.expires_at - result.server_time);
      setSelected(result.seat_ids);
      setHold(result);
      setKey(crypto.randomUUID());
    } catch (e) {
      setError((e as Error).message);
      void refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const checkout = async () => {
    if (!hold) return;
    setBusy(true);
    setError("");
    try {
      const order = await api<Order>("/checkout", {
        method: "POST",
        body: JSON.stringify({ hold_id: hold.id }),
        headers: { "Idempotency-Key": key },
      });
      setHold(null);
      onBooked(order);
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 409) {
        setHold(null);
        setSelected([]);
        setAgreed(false);
      }
    } finally {
      setBusy(false);
    }
  };
  const goBack = async () => {
    if (!hold) return;
    setBusy(true);
    setError("");
    try {
      await api(`/holds/${hold.id}`, { method: "DELETE" });
      setHold(null);
      setAgreed(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    if (hold)
      void api(`/holds/${hold.id}`, { method: "DELETE" }).catch(() => {});
    onClose();
  };
  return (
    <Modal
      onClose={close}
      busy={busy}
      label={`Book ${event.title}`}
      className="booking-modal"
    >
      <div className="booking-event">
        <img src={event.image} alt="" />
        <div>
          <span className="eyebrow">
            {event.category} ·{" "}
            {eventDate(event.starts_at, event.city, { weekday: "short" })}
          </span>
          <h2>{event.title}</h2>
          <p>
            <MapPin size={14} /> {event.venue}, {event.city}
          </p>
        </div>
      </div>
      <div className="booking-steps">
        <span className={!hold ? "current" : "done"}>
          <b>{hold ? <Check size={12} /> : "1"}</b> Pick your seats
        </span>
        <i />
        <span className={hold ? "current" : ""}>
          <b>2</b> Make it official
        </span>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={18} />
          <span>{error}</span>
        </div>
      )}
      <div className="booking-layout">
        <div className="booking-main">
          {!hold ? (
            <>
              <div className="seat-title">
                <div>
                  <h3>Find your perfect spot.</h3>
                  <p className="muted">
                    Select up to 6 seats. Every view is a good one.
                  </p>
                </div>
                <span className="live-tag">
                  <i /> Live availability
                </span>
              </div>
              {loading ? (
                <div className="loading-state">
                  <span className="spinner" /> Loading the best seats…
                </div>
              ) : (
                <div className="seat-map">
                  <div className="stage">
                    <span>S T A G E</span>
                  </div>
                  <div className="seat-rows">
                    {"ABCDEF".split("").map((row) => (
                      <div className="seat-row" key={row}>
                        <span className="row-label">{row}</span>
                        {seats
                          .filter((s) => s.row === row)
                          .map((seat) => (
                            <button
                              key={seat.id}
                              disabled={seat.status !== "available" || busy}
                              className={`seat ${seat.section.toLowerCase().replace(" ", "-")} ${selected.includes(seat.id) ? "selected" : seat.status} ${seat.number === 7 ? "aisle" : ""}`}
                              onClick={() => toggle(seat)}
                              aria-label={`Seat ${seat.id}, ${seat.section}, ${money(seat.price_cents)}, ${seat.status}`}
                              aria-pressed={selected.includes(seat.id)}
                              title={`${seat.id} · ${seat.section} · ${money(seat.price_cents)}`}
                            >
                              {selected.includes(seat.id) ? (
                                <Check size={12} />
                              ) : (
                                seat.number
                              )}
                            </button>
                          ))}
                        <span className="row-label">{row}</span>
                      </div>
                    ))}
                  </div>
                  <div className="seat-legend">
                    <span>
                      <i className="legend-available" /> Available
                    </span>
                    <span>
                      <i className="legend-selected" /> Selected
                    </span>
                    <span>
                      <i className="legend-unavailable" /> Unavailable
                    </span>
                  </div>
                </div>
              )}
              <div className="section-prices">
                {["Front row", "Standard", "Balcony"].map((section) => {
                  const seat = seats.find((s) => s.section === section);
                  return (
                    <div key={section}>
                      <i
                        className={`section-dot ${section.toLowerCase().replace(" ", "-")}`}
                      />
                      <span>{section}</span>
                      <strong>{seat ? money(seat.price_cents) : "—"}</strong>
                    </div>
                  );
                })}
              </div>
              <div className="about-event">
                <h4>A little about the night</h4>
                <p>{event.description}</p>
                <div className="tags">
                  {event.tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="checkout-content">
              <button className="text-button" onClick={goBack} disabled={busy}>
                <ArrowLeft size={16} /> Change seats
              </button>
              <h3>You’ve got great taste.</h3>
              <p className="muted">
                We’re keeping your seats warm. Confirm your demo booking below.
              </p>
              <div className="hold-timer">
                <Clock3 size={24} />
                <div>
                  <strong>Your seats are reserved</strong>
                  <span>Complete your booking before the timer runs out.</span>
                </div>
                <b>
                  {Math.floor(remaining / 60)}:
                  {String(remaining % 60).padStart(2, "0")}
                </b>
              </div>
              <div className="checkout-section">
                <h4>
                  <Ticket size={18} /> Your tickets
                </h4>
                {selectedSeats.map((seat) => (
                  <div className="checkout-seat" key={seat.id}>
                    <div>
                      <strong>{seat.section}</strong>
                      <span>
                        Row {seat.row} · Seat {seat.number}
                      </span>
                    </div>
                    <b>{money(seat.price_cents)}</b>
                  </div>
                ))}
              </div>
              <div className="demo-payment">
                <div className="demo-payment-icon">
                  <ShieldCheck size={24} />
                </div>
                <div>
                  <strong>A test run, with all the excitement.</strong>
                  <p>
                    This is a demo checkout. No card details needed and no money
                    will be charged.
                  </p>
                </div>
                <span>DEMO</span>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                I understand this is a demo ticket and is not valid for
                admission.
              </label>
            </div>
          )}
        </div>
        <aside className="booking-summary">
          <span className="eyebrow">YOUR NEXT GREAT NIGHT</span>
          <h3>Booking summary</h3>
          <div className="summary-event">
            <strong>{event.title}</strong>
            <span>
              {eventDate(event.starts_at, event.city, { weekday: "long" })} ·{" "}
              {eventDate(event.starts_at, event.city, {
                hour: "numeric",
                minute: "2-digit",
                month: undefined,
                day: undefined,
              })}
            </span>
            <span>{event.venue}</span>
          </div>
          <div className="selected-seats">
            {selected.length ? (
              selected.map((id) => <span key={id}>{id}</span>)
            ) : (
              <p>Pick a seat to get started.</p>
            )}
          </div>
          <div className="summary-line">
            <span>Tickets ({selected.length})</span>
            <b>{money(subtotal, true)}</b>
          </div>
          <div className="summary-line">
            <span>Service fee (8%)</span>
            <b>{money(fee, true)}</b>
          </div>
          <div className="summary-total">
            <span>
              Total <small>USD</small>
            </span>
            <strong>{money(subtotal + fee, true)}</strong>
          </div>
          <button
            className="button primary full"
            disabled={
              busy || (!hold && !selected.length) || (!!hold && !agreed)
            }
            onClick={hold ? checkout : reserve}
          >
            {busy ? (
              <span className="spinner" />
            ) : (
              <>
                {hold ? "Confirm demo booking" : "Reserve my seats"}
                <ArrowRight size={17} />
              </>
            )}
          </button>
          <p className="secure-note">
            <LockKeyhole size={13} />
            {hold
              ? "Secure, simulated checkout"
              : "Seats are held for 5 minutes"}
          </p>
          <div className="summary-promise">
            <CheckCircle2 size={17} />
            <p>
              <strong>Less worry. More live.</strong>
              <br />
              The price you see is the price you pay.
            </p>
          </div>
        </aside>
      </div>
    </Modal>
  );
}
