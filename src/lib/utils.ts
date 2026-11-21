import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function money(paise: number) {
  const value = BigInt(Math.abs(paise));
  const fraction = value % 100n;
  const rupees = new Intl.NumberFormat("en-IN").format(value / 100n);
  return (paise < 0 ? "-₹" : "₹") + rupees + (fraction ? "." + String(fraction).padStart(2, "0") : "");
}

export function decimalHundredths(value: FormDataEntryValue | null) {
  const [whole, fraction = ""] = String(value ?? "").split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export const bookingLabel: Record<string, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};

export function displayDate(value: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeStyle: "short", timeZone }).format(
    new Date(value),
  );
}

export function displayTime(value: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}
