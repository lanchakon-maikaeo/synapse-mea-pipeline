import type { ReactNode } from "react";

// Shared page header used by every menu (warehouse and transport).
export function PageHero({
  icon,
  eyebrow,
  title,
  description,
  meta = [],
  aside,
}: {
  icon: string;
  eyebrow: string;
  title: string;
  description: string;
  meta?: Array<[string, string]>;
  aside?: ReactNode;
}) {
  return (
    <header className="page-hero">
      <div className="page-hero-icon" aria-hidden="true">{icon}</div>
      <div className="page-hero-copy">
        <span className="page-hero-eyebrow"><i aria-hidden="true" />{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {(meta.length > 0 || aside) && (
        <div className="page-hero-aside">
          {meta.map(([label, value]) => (
            <div className="hero-chip" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
          {aside}
        </div>
      )}
    </header>
  );
}
