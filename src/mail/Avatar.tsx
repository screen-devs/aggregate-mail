import { memo, useContext, useState } from "react";
import { logoDomain, type Mail, type Provider } from "../../shared/types";
import { redactPrivateText } from "../privacy";
import { PrivacyContext } from "../ui/Privacy";
import { Cloud, Gmail, Mail as MailIcon } from "../ui/icons";

export function ProviderIcon({ provider }: { provider: Provider }) {
  return (
    <span className={`provider-icon ${provider === "gmail-imap" ? "gmail" : provider}`} aria-hidden="true">
      {provider === "gmail" || provider === "gmail-imap" ? (
        <Gmail />
      ) : provider === "icloud" ? (
        <Cloud />
      ) : provider === "imap" ? (
        <MailIcon color="currentColor" />
      ) : (
        <b>
          {provider === "fastmail" ? "F" : "y!"}
        </b>
      )}
    </span>
  );
}
export const Avatar = memo(function Avatar({
  mail,
  provider,
}: {
  mail: Mail;
  provider?: Provider;
}) {
  const domain = logoDomain(mail.address);
  const [broken, setBroken] = useState(false);
  const { on, names } = useContext(PrivacyContext);
  const initial = mail.sender.slice(0, 1).toUpperCase();
  return (
    <span className="avatar" aria-hidden="true">
      {domain && !broken ? (
        <img
          className="avatar-logo"
          src={`/api/logo/${domain}`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="avatar-letter">
          {on && redactPrivateText(initial, names) !== initial ? "·" : initial}
        </span>
      )}
      {provider && <ProviderIcon provider={provider} />}
    </span>
  );
});
