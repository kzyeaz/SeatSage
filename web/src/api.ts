export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch {
    throw new ApiError(
      0,
      "We couldn’t reach SeatSage. Check your connection and try again.",
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail;
    throw new ApiError(
      response.status,
      typeof detail === "string"
        ? detail
        : detail?.[0]?.msg || "Something went wrong. Please try again.",
    );
  }
  return body as T;
}

export const money = (cents: number, decimals = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals || cents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);

const timezones: Record<string, string> = {
  "New York": "America/New_York",
  Chicago: "America/Chicago",
  "Los Angeles": "America/Los_Angeles",
};
export const eventDate = (
  date: string,
  city: string,
  options: Intl.DateTimeFormatOptions = {},
) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...options,
    timeZone: timezones[city] || "UTC",
  }).format(new Date(date));
