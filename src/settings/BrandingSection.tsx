import type { LogoSummary } from "../../shared/types";
import type { Api, Perform } from "../api";

export function BrandingSection({
  api,
  perform,
  busy,
  onNotice,
}: {
  api: Api;
  perform: Perform;
  busy: boolean;
  onNotice: (text: string) => void;
}) {
  return (
    <section className="settings-logos">
      <p className="note">
        Fetch missing company logos for cached senders from theSVG, an open
        brand icon library. Logos stay cached on this computer; unknown companies keep their letter.
      </p>
      <div className="settings-row">
        <span>Company logos</span>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const { total, found, missing, failed } = await api<LogoSummary>(
                "/logos/sync",
                "POST",
              );
              onNotice(
                `Logos scanned: ${total} company ${total === 1 ? "domain" : "domains"}, ${found} found, ${missing} not in the library${failed ? `, ${failed} failed` : ""}.`,
              );
            })
          }
        >
          Fetch company logos
        </button>
      </div>
    </section>
  );
}
