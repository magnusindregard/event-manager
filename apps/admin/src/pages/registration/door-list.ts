import type { Api } from "../../api.js";

/** Downloads the door list as CSV (semicolon-separated, so Excel in Norway opens it). */
export async function downloadDoorList(api: Api, occurrenceId: string, answers: boolean, locale: string): Promise<void> {
  const r = await api.GET("/v1/occurrences/{id}/door-list.csv", { params: { path: { id: occurrenceId }, query: { answers, locale } }, parseAs: "blob" });
  if (!r.data) throw new Error("Could not download the door list");
  const url = URL.createObjectURL(r.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `door-list-${occurrenceId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
