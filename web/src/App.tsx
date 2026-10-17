import { useEffect, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  CalendarDays,
  Check,
  ChevronDown,
  Compass,
  Heart,
  LayoutDashboard,
  MapPin,
  Mic2,
  Music2,
  Search,
  ShieldCheck,
  Sparkles,
  Ticket,
  Timer,
  Trophy,
  Theater,
  X,
} from "lucide-react";
import { api, ApiError, eventDate, money } from "./api";
import type { Event, Order, User } from "./types";
import Booking, { Receipt } from "./Booking";
import Organizer from "./Organizer";
import Modal from "./Modal";

type Page = "explore" | "tickets" | "saved" | "organizer";
const categories = [
  { name: "All experiences", icon: Compass },
  { name: "Music", icon: Music2 },
  { name: "Sports", icon: Trophy },
  { name: "Theater", icon: Theater },
  { name: "Comedy", icon: Mic2 },
];

function EventCard({
  event,
  saved,
  onSave,
  onOpen,
}: {
  event: Event;
  saved: boolean;
  onSave: () => void;
  onOpen: () => void;
}) {
  return (
    <article className="event-card">
      <div className="event-image">
        <button
          className="image-link"
          onClick={onOpen}
          aria-label={`View ${event.title}`}
        >
          <img
            src={event.image}
            alt={`${event.category} at ${event.venue}`}
            loading="lazy"
          />
        </button>
        <span className="image-category">{event.category}</span>
        <button
          className={`save-button ${saved ? "is-saved" : ""}`}
          onClick={onSave}
          aria-label={`${saved ? "Unsave" : "Save"} ${event.title}`}
          aria-pressed={saved}
        >
          <Heart size={18} fill={saved ? "currentColor" : "none"} />
        </button>
        <div className="date-badge">
          <span>
            {eventDate(event.starts_at, event.city, {
              month: "short",
              day: undefined,
            })}
          </span>
          <strong>
            {eventDate(event.starts_at, event.city, {
              month: undefined,
              day: "numeric",
            })}
          </strong>
        </div>
      </div>
      <div className="event-card-content">
        <div className="event-time">
          <span>
            {eventDate(event.starts_at, event.city, {
              weekday: "long",
              month: undefined,
              day: undefined,
            })}{" "}
            ·{" "}
            {eventDate(event.starts_at, event.city, {
              hour: "numeric",
              minute: "2-digit",
              month: undefined,
              day: undefined,
            })}
          </span>
          <span className="availability-dot" />
        </div>
        <h3>
          <button onClick={onOpen}>{event.title}</button>
        </h3>
        <p>
          <MapPin size={14} />
          {event.venue} · {event.city}
        </p>
        <div className="event-card-bottom">
          <span>
            From <strong>{money(event.from_price_cents)}</strong>
            <small> + fees</small>
          </span>
          <button
            onClick={onOpen}
            className="card-cta"
            aria-label={`Get tickets for ${event.title}`}
          >
            <ArrowUpRight size={20} />
          </button>
        </div>
      </div>
    </article>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("explore");
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState("local");
  const [events, setEvents] = useState<Event[]>([]);
  const [featured, setFeatured] = useState<Event | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [category, setCategory] = useState("");
  const [city, setCity] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState("recommended");
  const [saved, setSaved] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem("seatsage-saved") || "[]");
      return Array.isArray(value)
        ? value.filter((v) => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [booking, setBooking] = useState<Event | null>(null);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [info, setInfo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [revision, setRevision] = useState(0);
  const [switching, setSwitching] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };
  useEffect(() => {
    const boot = async () => {
      try {
        let session: User;
        try {
          session = await api<User>("/session");
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 401) throw e;
          session = await api<User>("/demo/session", {
            method: "POST",
            body: JSON.stringify({ role: "attendee" }),
          });
        }
        setUser(session);
        const [health, all] = await Promise.all([
          api<{ mode: string }>("/health"),
          api<{ items: Event[] }>("/events"),
        ]);
        setMode(health.mode);
        setFeatured(all.items.find((e) => e.featured) || all.items[0]);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    void boot();
  }, [revision]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (page !== "explore" && page !== "saved") return;
    let active = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      q: debouncedQuery,
      category,
      city,
      sort,
    });
    api<{ items: Event[] }>(`/events?${params}`)
      .then((data) => {
        if (active) setEvents(data.items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [category, city, sort, debouncedQuery, revision, page]);
  useEffect(() => {
    if (page !== "tickets" || !user) return;
    let active = true;
    setLoading(true);
    setError("");
    api<{ items: Order[] }>("/orders")
      .then((data) => {
        if (active) setOrders(data.items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, revision, user]);
  const navigate = (next: Page) => {
    setPage(next);
    setError("");
    setQuery("");
    setDebouncedQuery("");
    setCategory("");
    setCity("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const openEvent = (event: Event) => {
    if (!user) {
      notify(
        "Connecting your demo session. If this persists, refresh the page.",
      );
      return;
    }
    setBooking(event);
  };
  const toggleSave = (event: Event) => {
    const next = saved.includes(event.id)
      ? saved.filter((id) => id !== event.id)
      : [...saved, event.id];
    setSaved(next);
    try {
      localStorage.setItem("seatsage-saved", JSON.stringify(next));
    } catch {
      /* Memory state still works. */
    }
    notify(
      next.includes(event.id)
        ? "Saved for a future good time."
        : "Removed from your saved events.",
    );
  };
  const switchRole = async () => {
    setSwitching(true);
    try {
      const role = page === "organizer" ? "attendee" : "organizer";
      setUser(
        await api<User>("/demo/session", {
          method: "POST",
          body: JSON.stringify({ role }),
        }),
      );
      navigate(role === "organizer" ? "organizer" : "explore");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };
  const displayed =
    page === "saved" ? events.filter((e) => saved.includes(e.id)) : events;
  const clearFilters = () => {
    setQuery("");
    setDebouncedQuery("");
    setCategory("");
    setCity("");
    setSort("recommended");
  };
  const isFiltered = !!(query || category || city);
  return (
    <>
      <div className="announcement">
        <span>A little less scrolling. A lot more living.</span>
        <span>
          Find your next live experience <ArrowUpRight size={13} />
        </span>
      </div>
      <header className="site-header">
        <div className="header-inner">
          <button
            className="brand"
            onClick={() => navigate("explore")}
            aria-label="SeatSage home"
          >
            <span className="brand-mark">
              <Ticket size={24} strokeWidth={2.1} />
            </span>
            <span>
              seat<span className="brand-light">sage</span>
              <i>®</i>
            </span>
          </button>
          <nav aria-label="Main navigation">
            <button
              className={page === "explore" ? "active" : ""}
              onClick={() => navigate("explore")}
            >
              Explore
            </button>
            <button
              className={page === "tickets" ? "active" : ""}
              onClick={() => navigate("tickets")}
            >
              My tickets
            </button>
            <button
              className={page === "saved" ? "active" : ""}
              onClick={() => navigate("saved")}
            >
              Saved{" "}
              {saved.length > 0 && (
                <span className="nav-count">{saved.length}</span>
              )}
            </button>
          </nav>
          <div className="header-actions">
            <button
              className="organizer-button"
              aria-label={
                page === "organizer" ? "Back to exploring" : "For organizers"
              }
              onClick={switchRole}
              disabled={switching}
            >
              <LayoutDashboard size={15} />
              <span>
                {page === "organizer" ? "Back to exploring" : "For organizers"}
              </span>
              <ArrowUpRight size={14} />
            </button>
            <span className="header-divider" />
            <button
              className="avatar"
              aria-label="About your demo account"
              onClick={() => setInfo(true)}
            >
              AM
            </button>
          </div>
        </div>
      </header>
      <main className="main-container">
        {page === "organizer" ? (
          <Organizer notify={notify} />
        ) : page === "tickets" ? (
          <div className="tickets-page">
            <div className="page-heading">
              <div>
                <span className="eyebrow">PLANS WORTH LOOKING FORWARD TO</span>
                <h1>Good times, on the calendar.</h1>
                <p>All your upcoming experiences, in one happy place.</p>
              </div>
              <span className="outline-badge">
                <Ticket size={16} />
                My tickets
              </span>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                {error}
                <button
                  className="text-button"
                  onClick={() => setRevision((r) => r + 1)}
                >
                  Try again
                </button>
              </div>
            )}
            {loading ? (
              <div className="loading-state">
                <span className="spinner" />
                Finding your tickets…
              </div>
            ) : !orders.length ? (
              <div className="empty-state">
                <div className="empty-illustration">
                  <Ticket size={44} />
                  <Sparkles size={23} />
                </div>
                <h2>Your next story starts here.</h2>
                <p>
                  No tickets yet. There’s a whole world of live experiences
                  waiting for you.
                </p>
                <button
                  className="button primary"
                  onClick={() => navigate("explore")}
                >
                  Find your next experience <ArrowRight size={17} />
                </button>
              </div>
            ) : (
              <div className="ticket-list">
                {orders.map((order) => (
                  <article className="order-card" key={order.id}>
                    <img src={order.event.image} alt="" />
                    <div>
                      <span className="category-label">
                        {order.event.category}{" "}
                        <span className="confirmed">
                          <Check size={12} />
                          Confirmed
                        </span>
                      </span>
                      <h2>{order.event.title}</h2>
                      <p>
                        <CalendarDays size={15} />
                        {eventDate(order.event.starts_at, order.event.city, {
                          weekday: "long",
                        })}
                      </p>
                      <p>
                        <MapPin size={15} />
                        {order.event.venue}, {order.event.city}
                      </p>
                      <span className="order-seats">
                        {order.seats.length}{" "}
                        {order.seats.length === 1 ? "ticket" : "tickets"} ·
                        Seats {order.seats.map((s) => s.id).join(", ")}
                      </span>
                    </div>
                    <div className="order-action">
                      <span>DEMO BOOKING</span>
                      <strong>{money(order.total_cents)}</strong>
                      <button
                        className="button secondary"
                        onClick={() => setReceipt(order)}
                      >
                        View ticket <ArrowUpRight size={16} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="page-heading explore-heading">
              <div>
                <div className="heading-kicker">
                  <span className="little-star">✳</span> GO OUT. TUNE IN. SHOW
                  UP.
                </div>
                <h1>
                  {page === "saved" ? (
                    "Keep the good ones close."
                  ) : (
                    <>
                      Your next <span>“I was there.”</span>
                    </>
                  )}
                </h1>
                <p>
                  {page === "saved"
                    ? "A little collection of experiences you don’t want to miss."
                    : "Big nights, close-up moments, and everything in between. Find your seat."}
                </p>
              </div>
              <div className="city-select">
                <MapPin size={17} />
                <select
                  aria-label="Choose city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                >
                  <option value="">All cities</option>
                  <option>New York</option>
                  <option>Chicago</option>
                  <option>Los Angeles</option>
                </select>
                <ChevronDown size={14} />
              </div>
            </div>
            {page === "explore" && !isFiltered && featured && (
              <section
                className="spotlight-grid"
                aria-label="Featured experience"
              >
                <div
                  className="hero-card"
                  style={{ backgroundImage: `url("${featured.image}")` }}
                >
                  <div className="hero-shade" />
                  <div className="hero-topline">
                    <span>
                      <Sparkles size={13} />
                      IN THE SPOTLIGHT
                    </span>
                    <button
                      onClick={() => toggleSave(featured)}
                      className={`hero-save ${saved.includes(featured.id) ? "is-saved" : ""}`}
                      aria-label={`${saved.includes(featured.id) ? "Unsave" : "Save"} featured event`}
                    >
                      <Heart
                        size={19}
                        fill={
                          saved.includes(featured.id) ? "currentColor" : "none"
                        }
                      />
                    </button>
                  </div>
                  <div className="hero-content">
                    <span className="hero-kicker">
                      ONE NIGHT. ALL THE FEELS.
                    </span>
                    <h2>
                      AFTERGLOW<span>MUSIC FESTIVAL</span>
                    </h2>
                    <p>
                      <CalendarDays size={16} />
                      {eventDate(featured.starts_at, featured.city, {
                        weekday: "short",
                      })}
                      <i />
                      {featured.venue}, {featured.city}
                    </p>
                    <div className="hero-bottom">
                      <button
                        className="button lime"
                        onClick={() => openEvent(featured)}
                      >
                        Be part of it <ArrowUpRight size={18} />
                      </button>
                      <span>
                        From <strong>{money(featured.from_price_cents)}</strong>
                      </span>
                    </div>
                  </div>
                  <div className="hero-pagination">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
                <div className="editorial-card">
                  <div className="editorial-top">
                    <span>
                      LESS FOMO.
                      <br />
                      MORE FRONT ROW.
                    </span>
                    <ArrowUpRight size={26} />
                  </div>
                  <div className="orbit-art" aria-hidden="true">
                    <div className="orbit o1" />
                    <div className="orbit o2" />
                    <div className="orbit o3" />
                    <div className="orbit o4" />
                    <div className="orbit o5" />
                    <span>✳</span>
                    <div className="floating-ticket">
                      <Ticket size={26} />
                      <div>
                        ADMIT ONE<small>TO SOMETHING GREAT</small>
                      </div>
                    </div>
                  </div>
                  <div className="editorial-bottom">
                    <h2>
                      Life sounds
                      <br />
                      better live.
                    </h2>
                    <p>
                      Find the kind of night
                      <br />
                      you’ll talk about for years.
                    </p>
                    <button
                      className="round-arrow"
                      aria-label="Browse all experiences"
                      onClick={() =>
                        document
                          .getElementById("experiences")
                          ?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          })
                      }
                    >
                      <ArrowRight size={22} />
                    </button>
                  </div>
                </div>
              </section>
            )}
            <section id="experiences" className="experiences-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">
                    {page === "saved"
                      ? "YOUR PERSONAL SHORTLIST"
                      : "GET OUT THERE"}
                  </span>
                  <h2>
                    {page === "saved"
                      ? "Your saved experiences"
                      : "Find your kind of live."}
                  </h2>
                </div>
                <div className="search-field">
                  <Search size={18} />
                  <input
                    aria-label="Search events"
                    placeholder="Artists, events, or venues…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      className="icon-button"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <X size={15} />
                    </button>
                  )}
                  <kbd>⌕</kbd>
                </div>
              </div>
              <div className="filters-row">
                <div
                  className="category-tabs"
                  role="group"
                  aria-label="Event categories"
                >
                  {categories.map(({ name, icon: Icon }, index) => (
                    <button
                      className={
                        category === (index === 0 ? "" : name) ? "active" : ""
                      }
                      key={name}
                      onClick={() => setCategory(index === 0 ? "" : name)}
                    >
                      <Icon size={16} />
                      {name}
                    </button>
                  ))}
                </div>
                <label className="sort-select">
                  <ArrowDownUp size={14} />
                  <select
                    aria-label="Sort events"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="recommended">Recommended</option>
                    <option value="date">Soonest first</option>
                    <option value="price">Lowest price</option>
                  </select>
                  <ChevronDown size={12} />
                </label>
              </div>
              {error && (
                <div className="error-banner" role="alert">
                  {error}
                  <button
                    className="text-button"
                    onClick={() => setRevision((r) => r + 1)}
                  >
                    Try again
                  </button>
                </div>
              )}
              {loading ? (
                <div className="event-grid">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="skeleton-card">
                      <div />
                      <span />
                      <span />
                      <span />
                    </div>
                  ))}
                </div>
              ) : displayed.length ? (
                <>
                  <div className="results-label">
                    <span>
                      {displayed.length} experiences to look forward to
                    </span>
                    {isFiltered && (
                      <button className="text-button" onClick={clearFilters}>
                        Clear filters <X size={13} />
                      </button>
                    )}
                  </div>
                  <div className="event-grid">
                    {displayed.map((event) => (
                      <EventCard
                        key={event.id}
                        event={event}
                        saved={saved.includes(event.id)}
                        onSave={() => toggleSave(event)}
                        onOpen={() => openEvent(event)}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <div className="empty-illustration">
                    {page === "saved" ? (
                      <Bookmark size={38} />
                    ) : (
                      <Search size={38} />
                    )}
                  </div>
                  <h2>
                    {page === "saved" && !isFiltered
                      ? "Good things are worth saving."
                      : "No matches. Plenty of possibilities."}
                  </h2>
                  <p>
                    {page === "saved" && !isFiltered
                      ? "Tap the heart on any event to keep it here for later."
                      : "Try another city, category, or search to find your next experience."}
                  </p>
                  <button
                    className="button secondary"
                    onClick={
                      page === "saved" && !isFiltered
                        ? () => navigate("explore")
                        : clearFilters
                    }
                  >
                    {page === "saved" && !isFiltered
                      ? "Explore events"
                      : "Clear filters"}
                    <ArrowRight size={16} />
                  </button>
                </div>
              )}
            </section>
            <section className="peace-of-mind">
              <div className="peace-heading">
                <span className="little-star">✳</span>
                <h2>
                  More memories.
                  <br />
                  Less second-guessing.
                </h2>
              </div>
              <div>
                <ShieldCheck size={24} />
                <h3>Your seat is yours.</h3>
                <p>
                  Real-time availability.
                  <br />
                  One seat, one happy fan.
                </p>
              </div>
              <div>
                <Timer size={24} />
                <h3>A moment to make it yours.</h3>
                <p>
                  Five-minute seat holds.
                  <br />
                  Take a breath. Make a plan.
                </p>
              </div>
              <div>
                <Ticket size={24} />
                <h3>Good nights. Clear prices.</h3>
                <p>
                  See your total before checkout.
                  <br />
                  No last-minute surprises.
                </p>
              </div>
            </section>
          </>
        )}
      </main>
      <footer className="site-footer">
        <div>
          <button
            className="brand footer-brand"
            onClick={() => navigate("explore")}
          >
            <span className="brand-mark">
              <Ticket size={20} />
            </span>
            <span>
              seat<span className="brand-light">sage</span>
            </span>
          </button>
          <p>Be there. Feel everything.</p>
        </div>
        <span className="footer-copyright">
          © {new Date().getFullYear()} SeatSage. Made for the moment.
        </span>
        <button className="demo-indicator" onClick={() => setInfo(true)}>
          <i />
          {mode === "distributed" ? "Full stack demo" : "Local demo"}
          <ArrowUpRight size={12} />
        </button>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={15} />
          </span>
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {booking && (
        <Booking
          event={booking}
          onClose={() => setBooking(null)}
          onBooked={(order) => {
            setBooking(null);
            setReceipt(order);
            setRevision((r) => r + 1);
          }}
        />
      )}
      {receipt && (
        <Receipt
          order={receipt}
          onClose={() => setReceipt(null)}
          onTickets={() => {
            setReceipt(null);
            navigate("tickets");
          }}
        />
      )}
      {info && (
        <Modal
          onClose={() => setInfo(false)}
          label="About this demo"
          className="info-modal"
        >
          <div className="info-icon">
            <Sparkles size={28} />
          </div>
          <span className="eyebrow">WELCOME TO THE PLAYGROUND</span>
          <h2>
            Big experiences.
            <br />A little demo magic.
          </h2>
          <p>
            You’re exploring SeatSage as{" "}
            <strong>{user?.name || "a demo guest"}</strong>. Pick seats, make a
            simulated booking, and see it show up in My tickets.
          </p>
          <div className="info-feature">
            <Ticket size={20} />
            <div>
              <strong>All the flow. No actual charge.</strong>
              <p>
                Events and tickets are examples. No payment information is
                collected.
              </p>
            </div>
          </div>
          <div className="info-feature">
            <LayoutDashboard size={20} />
            <div>
              <strong>Try the other side of the stage.</strong>
              <p>
                Use “For organizers” to publish an event and see demo sales
                arrive.
              </p>
            </div>
          </div>
          <div className="mode-detail">
            <span className="live-tag">
              <i />
              {mode === "distributed" ? "Distributed mode" : "Local demo mode"}
            </span>
            <p>
              {mode === "distributed"
                ? "FastAPI · Go · PostgreSQL · Redis · Elasticsearch"
                : "React + FastAPI + SQLite. The full service stack is included in Docker Compose."}
            </p>
          </div>
          <button
            className="button primary full"
            onClick={() => setInfo(false)}
          >
            Let’s find a good night <ArrowRight size={17} />
          </button>
        </Modal>
      )}
    </>
  );
}
