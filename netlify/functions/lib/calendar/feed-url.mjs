// The one check for a calendar feed address. Used for the address typed in the panel and for every redirect hop.
const ALLOWED_HOST = "calendar.google.com";

export class FeedInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedInputError";
  }
}

// Only https, only the calendar provider host, only an .ics path. Everything else is refused.
export function checkFeedUrl(value) {
  let u;
  try {
    u = new URL(String(value || ""));
  } catch {
    throw new FeedInputError("The feed address is not a valid web address.");
  }
  if (
    u.protocol !== "https:" ||
    u.hostname !== ALLOWED_HOST ||
    u.port ||
    u.username ||
    u.password ||
    !/\.ics$/i.test(u.pathname)
  ) {
    throw new FeedInputError("The feed address must be an https calendar link that ends in .ics.");
  }
  return u.toString();
}
