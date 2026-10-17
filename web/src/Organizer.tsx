import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  CircleDollarSign,
  Plus,
  Ticket,
  Users,
} from "lucide-react";
import { api, eventDate, money } from "./api";
import type { Dashboard, Event } from "./types";
import Modal from "./Modal";

function CreateEvent({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      await api<Event>("/organizer/events", {
        method: "POST",
        body: JSON.stringify({
          title: data.get("title"),
          category: data.get("category"),
          city: data.get("city"),
          venue: data.get("venue"),
          starts_at: new Date(data.get("date") as string).toISOString(),
          description: data.get("description"),
          base_price_cents: Math.round(Number(data.get("price")) * 100),
        }),
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      onClose={onClose}
      busy={busy}
      label="Create an event"
      className="create-modal"
    >
      <span className="eyebrow">MAKE SOMETHING HAPPEN</span>
      <h2>Bring people together.</h2>
      <p className="muted">
        Publish a demo event with 72 reserved seats across three sections.
      </p>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <form onSubmit={submit} className="event-form">
        <label>
          Event name
          <input
            name="title"
            placeholder="Give your night a name"
            minLength={3}
            maxLength={100}
            required
          />
        </label>
        <div className="form-row">
          <label>
            Category
            <select name="category">
              {["Music", "Sports", "Theater", "Comedy"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            City
            <select name="city">
              {["New York", "Chicago", "Los Angeles"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Venue
          <input
            name="venue"
            placeholder="Where the magic happens"
            minLength={3}
            maxLength={100}
            required
          />
        </label>
        <div className="form-row">
          <label>
            Date & time <small>(your timezone)</small>
            <input name="date" type="datetime-local" required />
          </label>
          <label>
            Starting price (USD)
            <input
              name="price"
              type="number"
              min="5"
              max="1000"
              step="0.01"
              defaultValue="35"
              required
            />
          </label>
        </div>
        <label>
          About the event
          <textarea
            name="description"
            placeholder="Tell people what makes this one special…"
            minLength={20}
            maxLength={2000}
            rows={4}
            required
          />
        </label>
        <p className="muted form-note">
          Balcony seats use your starting price. Standard seats add $15, and
          front row seats add $40.
        </p>
        <button className="button primary full" disabled={busy}>
          {busy ? (
            <span className="spinner" />
          ) : (
            <>
              <Plus size={17} />
              Publish demo event
            </>
          )}
        </button>
      </form>
    </Modal>
  );
}

export default function Organizer({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    api<Dashboard>("/organizer/dashboard")
      .then((data) => {
        if (active) setDashboard(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return (
    <div className="organizer-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">THE OTHER SIDE OF A GREAT NIGHT</span>
          <h1>Your stage. Your people.</h1>
          <p>Bring the experience. We’ll help fill the seats.</p>
        </div>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={18} />
          Create an event
        </button>
      </div>
      <div className="organizer-notice">
        <span className="tiny-badge">ORGANIZER DEMO</span> You’re viewing a
        shared demo workspace. Sales update when a demo booking is completed.
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => {
              setError("");
              setRevision((r) => r + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {!dashboard ? (
        <div className="loading-state">
          <span className="spinner" />
          Getting your workspace ready…
        </div>
      ) : (
        <>
          <div className="metrics-grid">
            <div className="metric-card">
              <span>
                <CircleDollarSign size={19} />
                Ticket revenue
              </span>
              <strong>{money(dashboard.revenue_cents)}</strong>
              <small>Before service fees · simulated sales</small>
            </div>
            <div className="metric-card">
              <span>
                <Ticket size={19} />
                Tickets sold
              </span>
              <strong>
                {dashboard.tickets_sold}
                <em> / {dashboard.total_capacity}</em>
              </strong>
              <small>
                {dashboard.total_capacity
                  ? Math.round(
                      (dashboard.tickets_sold / dashboard.total_capacity) * 100,
                    )
                  : 0}
                % of total seats booked
              </small>
            </div>
            <div className="metric-card">
              <span>
                <CalendarDays size={19} />
                Published events
              </span>
              <strong>{dashboard.events.length}</strong>
              <small>Good times, ready to happen</small>
            </div>
          </div>
          <section className="organizer-section">
            <div className="section-heading">
              <h2>
                Your events{" "}
                <span className="count-badge">{dashboard.events.length}</span>
              </h2>
              <span className="live-tag">
                <i /> Live sales data
              </span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>EVENT</th>
                    <th>DATE</th>
                    <th>TICKETS SOLD</th>
                    <th>REVENUE</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.events.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <div className="table-event">
                          <img src={event.image} alt="" />
                          <div>
                            <strong>{event.title}</strong>
                            <span>
                              {event.venue} · {event.city}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>{eventDate(event.starts_at, event.city)}</td>
                      <td>
                        <span>
                          {event.tickets_sold}{" "}
                          <span className="muted">/ {event.capacity}</span>
                        </span>
                        <div className="sales-track">
                          <i
                            style={{
                              width: `${(event.tickets_sold / event.capacity) * 100}%`,
                            }}
                          />
                        </div>
                      </td>
                      <td className="table-money">
                        {money(event.revenue_cents)}
                      </td>
                      <td>
                        <span className="status-tag">Published</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="organizer-section">
            <div className="section-heading">
              <h2>Fresh off the press</h2>
              <span className="muted">Recent bookings</span>
            </div>
            {dashboard.recent_orders.length ? (
              <div className="recent-orders">
                {dashboard.recent_orders.map((order) => (
                  <div key={order.id}>
                    <span className="order-icon">
                      <ArrowDownLeft size={19} />
                    </span>
                    <div>
                      <strong>{order.title}</strong>
                      <span>
                        {order.quantity}{" "}
                        {order.quantity === 1 ? "ticket" : "tickets"} ·{" "}
                        {new Date(order.created_at * 1000).toLocaleString()}
                      </span>
                    </div>
                    <b>{money(order.total_cents)}</b>
                    <ArrowUpRight size={18} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="compact-empty">
                <Users size={28} />
                <h3>Your audience is on its way.</h3>
                <p>
                  Make a booking in Explore and your first sale will appear
                  here.
                </p>
              </div>
            )}
          </section>
        </>
      )}
      {creating && (
        <CreateEvent
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setRevision((r) => r + 1);
            notify("Your event is live. Let the good times begin!");
          }}
        />
      )}
    </div>
  );
}
