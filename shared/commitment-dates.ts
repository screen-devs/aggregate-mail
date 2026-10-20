import type { Commitment } from "./workspace.js";

export function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "0001-01-01" &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

// The pilot stored date-only deadlines at noon UTC. Keep their original day.
export function deadlineDate(item: Pick<Commitment, "dueDate" | "dueAt">) {
  return item.dueDate ?? (item.dueAt === undefined ? undefined : new Date(item.dueAt).toISOString().slice(0, 10));
}

export function localDate(value: Date) {
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function localTimeInput(value: number) {
  const date = new Date(value);
  return `${localDate(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export const openCommitment = (item: Commitment) => item.status !== "done" && item.status !== "cancelled";
