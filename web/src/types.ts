export type Event = {
  id: string;
  title: string;
  category: string;
  city: string;
  venue: string;
  starts_at: string;
  image: string;
  accent: string;
  description: string;
  tags: string[];
  featured: number;
  from_price_cents: number;
  capacity: number;
  available: number;
};

export type Seat = {
  id: string;
  row: string;
  number: number;
  section: string;
  price_cents: number;
  status: "available" | "held" | "sold";
  is_mine: boolean;
};

export type Hold = {
  id: string;
  event_id: string;
  seat_ids: string[];
  expires_at: number;
  server_time: number;
  subtotal_cents: number;
};

export type Order = {
  id: string;
  event_id: string;
  created_at: number;
  subtotal_cents: number;
  fee_cents: number;
  total_cents: number;
  seats: { id: string; section: string; price_cents: number }[];
  event: Omit<Event, "from_price_cents" | "capacity" | "available">;
};

export type User = { id: string; name: string; role: "attendee" | "organizer" };

export type Dashboard = {
  events: (Event & { tickets_sold: number; revenue_cents: number })[];
  recent_orders: {
    id: string;
    title: string;
    total_cents: number;
    quantity: number;
    created_at: number;
  }[];
  revenue_cents: number;
  tickets_sold: number;
  total_capacity: number;
};
