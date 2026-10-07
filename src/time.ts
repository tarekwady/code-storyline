/** "just now", "5 min ago", "today 10:42", "yesterday 18:05", "3 days ago", "12 Sep". */
export function when(ms: number, now: number = Date.now()): string {
  const today = new Date(now);
  const then = new Date(ms);
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const time = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(then)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: then.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
