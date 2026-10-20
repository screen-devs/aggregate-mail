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
    <section>
      <p className="note">
        Sender logos come from theSVG, an open brand icon library, and are
        cached on this computer. Scan the senders already in your inbox to
        fetch the ones that are still missing. Companies the library does not
        know keep their letter.
      </p>
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
    </section>
  );
}
