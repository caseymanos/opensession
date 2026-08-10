import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Clock3,
  ExternalLink,
  MapPin,
  Search,
  Sparkles,
} from "lucide-react";

import {
  ProductWordmark,
  StatePanel,
  StatusPill,
  TextField,
} from "@sessionbox-killer/ui";

import {
  isPublicSpeakerProjection,
  publicSpeakerProjectionFixture,
  sessionsForPublishedSpeaker,
  type PublishedSpeakerProfileView,
  type PublicSpeakerProjection,
} from "./publicSpeakerModel";

import "./public-speakers.css";

export type PublicSpeakersFixtureState =
  "empty" | "error" | "interactive" | "missing-profile" | "profile";

type LoadState =
  | { status: "error" }
  | { status: "loading" }
  | { status: "not-found" }
  | { projection: PublicSpeakerProjection; status: "ready" };

function routeDetails() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return {
    eventSlug: parts[0] === "e" ? parts[1] : undefined,
    speakerSlug: parts[2] === "speakers" ? parts[3] : undefined,
  };
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
}

function formatSessionDate(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(value));
}

function updateSearch(query: string) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  window.history.replaceState(
    null,
    "",
    params.size
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname,
  );
}

function PublicSpeakerHeader({
  eventSlug,
  speakersCurrent = false,
}: {
  eventSlug: string;
  speakersCurrent?: boolean;
}) {
  return (
    <header className="speaker-site-header">
      <a
        aria-label="OpenSession public program home"
        className="speaker-site-wordmark"
        href={`/e/${eventSlug}`}
      >
        <ProductWordmark />
      </a>
      <nav aria-label="Public program">
        <a href={`/e/${eventSlug}`}>Schedule</a>
        <a href={`/e/${eventSlug}?view=mine`}>My schedule</a>
        <a
          aria-current={speakersCurrent ? "page" : undefined}
          href={`/e/${eventSlug}/speakers`}
        >
          Speakers
        </a>
      </nav>
      <a className="speaker-site-organizer" href={`/app/${eventSlug}/home`}>
        Organizer sign in <ArrowRight aria-hidden="true" size={14} />
      </a>
    </header>
  );
}

function PublicSpeakerFooter() {
  return (
    <footer className="speaker-site-footer">
      <ProductWordmark />
      <p>Built for the people who make gatherings matter.</p>
      <span>© 2026 OpenSession</span>
    </footer>
  );
}

function SpeakerPortrait({
  eager = false,
  speaker,
}: {
  eager?: boolean;
  speaker: PublishedSpeakerProfileView;
}) {
  return speaker.headshot ? (
    <img
      alt={speaker.headshot.alt}
      decoding="async"
      fetchPriority={eager ? "high" : "auto"}
      height="760"
      loading={eager ? "eager" : "lazy"}
      src={speaker.headshot.url}
      width="640"
    />
  ) : (
    <span
      aria-label={`No published headshot for ${speaker.name}`}
      className="speaker-portrait-placeholder"
      role="img"
    >
      <b>{initials(speaker.name)}</b>
      <small>Portrait coming soon</small>
    </span>
  );
}

function SpeakerCard({
  projection,
  speaker,
}: {
  projection: PublicSpeakerProjection;
  speaker: PublishedSpeakerProfileView;
}) {
  const sessions = sessionsForPublishedSpeaker(projection, speaker);
  return (
    <article className="speaker-gallery-card">
      <a href={`/e/${projection.event.slug}/speakers/${speaker.slug}`}>
        <div className="speaker-gallery-portrait">
          <SpeakerPortrait speaker={speaker} />
          <span>
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="speaker-gallery-copy">
          <h2>{speaker.name}</h2>
          <p>{speaker.title}</p>
          <span>{speaker.company}</span>
          <small>
            View profile <ArrowRight aria-hidden="true" size={14} />
          </small>
        </div>
      </a>
    </article>
  );
}

function SpeakerGallery({
  projection,
}: {
  projection: PublicSpeakerProjection;
}) {
  const initialQuery =
    new URLSearchParams(window.location.search).get("q")?.slice(0, 120) ?? "";
  const [query, setQuery] = useState(initialQuery);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return projection.speakers.filter((speaker) =>
      `${speaker.name} ${speaker.company} ${speaker.title}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [projection.speakers, query]);

  return (
    <main className="speaker-gallery" id="speaker-content">
      <section className="speaker-gallery-hero" aria-labelledby="speaker-title">
        <div>
          <p className="overline">AI Engineer Summit · On stage</p>
          <h1 id="speaker-title">Meet the people building what’s next.</h1>
        </div>
        <div className="speaker-gallery-proof">
          <Sparkles aria-hidden="true" size={20} />
          <p>
            <strong>{projection.speakers.length} published speakers</strong>
            Approved profiles and sessions from public version{" "}
            {projection.version}
          </p>
        </div>
      </section>

      <section className="speaker-gallery-tools" aria-label="Find speakers">
        <TextField
          label="Search speakers"
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            updateSearch(nextQuery);
          }}
          placeholder="Name, company, or role"
          type="search"
          value={query}
        />
        <p role="status">
          <Search aria-hidden="true" size={15} /> {visible.length} speaker
          {visible.length === 1 ? "" : "s"} shown
        </p>
      </section>

      {projection.speakers.length === 0 ? (
        <StatePanel
          action={
            <a
              className="speaker-text-link"
              href={`/e/${projection.event.slug}`}
            >
              Browse the schedule <ArrowRight aria-hidden="true" size={14} />
            </a>
          }
          description="Published speaker profiles will appear here when they are part of the current public program."
          state="empty"
          title="Speakers are coming soon"
        />
      ) : visible.length === 0 ? (
        <StatePanel
          description="Try a different name, organization, or role."
          state="empty"
          title="No speakers match that search"
        />
      ) : (
        <section
          aria-label="Published speakers"
          className="speaker-gallery-grid"
        >
          {visible.map((speaker) => (
            <SpeakerCard
              key={speaker.slug}
              projection={projection}
              speaker={speaker}
            />
          ))}
        </section>
      )}
    </main>
  );
}

function SpeakerProfile({
  projection,
  speaker,
}: {
  projection: PublicSpeakerProjection;
  speaker: PublishedSpeakerProfileView;
}) {
  const sessions = sessionsForPublishedSpeaker(projection, speaker);
  return (
    <main className="speaker-public-profile" id="speaker-content">
      <a
        className="speaker-back-link"
        href={`/e/${projection.event.slug}/speakers`}
      >
        <ArrowLeft aria-hidden="true" size={15} /> All speakers
      </a>

      <article className="speaker-profile-hero">
        <div className="speaker-profile-portrait">
          <SpeakerPortrait eager speaker={speaker} />
        </div>
        <div className="speaker-profile-intro">
          <p className="overline">AI Engineer Summit · Speaker</p>
          <h1>{speaker.name}</h1>
          {speaker.pronouns ? <small>{speaker.pronouns}</small> : null}
          <p className="speaker-profile-role">
            {speaker.title} · {speaker.company}
          </p>
          <p
            className={
              speaker.bio
                ? "speaker-profile-bio"
                : "speaker-profile-bio is-missing"
            }
          >
            {speaker.bio ??
              "This speaker’s approved biography is not published yet. Their confirmed session is available below."}
          </p>
          {speaker.links.length ? (
            <nav
              aria-label={`${speaker.name} links`}
              className="speaker-profile-links"
            >
              {speaker.links.map((link) => (
                <a
                  href={link.url}
                  key={link.label}
                  rel="noreferrer"
                  target="_blank"
                >
                  {link.label} <ExternalLink aria-hidden="true" size={13} />
                </a>
              ))}
            </nav>
          ) : (
            <p className="speaker-profile-no-links">
              No public links provided.
            </p>
          )}
        </div>
      </article>

      <section
        className="speaker-profile-sessions"
        aria-labelledby="speaker-sessions-title"
      >
        <header>
          <div>
            <p className="overline">Published program</p>
            <h2 id="speaker-sessions-title">
              {sessions.length === 1 ? "Session" : "Sessions"} with{" "}
              {speaker.name.split(" ")[0]}
            </h2>
          </div>
          <StatusPill tone="success">
            Public version {projection.version}
          </StatusPill>
        </header>
        <div className="speaker-session-list">
          {sessions.map((session) => (
            <article key={session.id}>
              <a href={`/e/${projection.event.slug}/sessions/${session.id}`}>
                <div>
                  <span>{session.track}</span>
                  <h3>{session.title}</h3>
                </div>
                <dl>
                  <div>
                    <dt>
                      <CalendarDays aria-hidden="true" size={14} /> When
                    </dt>
                    <dd>
                      {formatSessionDate(
                        session.startAt,
                        projection.event.timezone,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <MapPin aria-hidden="true" size={14} /> Where
                    </dt>
                    <dd>{session.roomName}</dd>
                  </div>
                  <div>
                    <dt>
                      <Clock3 aria-hidden="true" size={14} /> Format
                    </dt>
                    <dd>{session.format}</dd>
                  </div>
                </dl>
                <span className="speaker-session-arrow" aria-hidden="true">
                  <ArrowRight size={18} />
                </span>
              </a>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function PublicSpeakerState({
  state,
}: {
  state: "error" | "loading" | "not-found";
}) {
  const loading = state === "loading";
  return (
    <main className="speaker-state" id="speaker-content">
      <StatePanel
        description={
          loading
            ? "Fetching approved profiles from the current public version."
            : state === "not-found"
              ? "This event or speaker is not part of the current public program."
              : "The published speaker directory could not be loaded. The schedule is still available."
        }
        onRetry={state === "error" ? () => window.location.reload() : undefined}
        state={loading ? "loading" : "error"}
        title={
          loading
            ? "Loading published speakers"
            : state === "not-found"
              ? "Speaker not found"
              : "We couldn’t load the speakers"
        }
      />
    </main>
  );
}

export function PublicSpeakers({
  fixtureState,
}: {
  fixtureState?: PublicSpeakersFixtureState | undefined;
}) {
  const route = fixtureState
    ? {
        eventSlug: publicSpeakerProjectionFixture.event.slug,
        speakerSlug:
          fixtureState === "missing-profile"
            ? "jo-bell"
            : fixtureState === "profile"
              ? "sam-rivera"
              : undefined,
      }
    : routeDetails();
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (fixtureState || !route.eventSlug) return;
    const controller = new AbortController();
    async function loadSpeakers() {
      try {
        const response = await fetch(
          `/api/v1/public/events/${encodeURIComponent(route.eventSlug ?? "")}/speakers`,
          {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (response.status === 404) {
          setLoadState({ status: "not-found" });
          return;
        }
        if (!response.ok)
          throw new Error(`Speaker request failed: ${response.status}`);
        const payload: unknown = await response.json();
        if (
          !isPublicSpeakerProjection(payload) ||
          payload.event.slug !== route.eventSlug
        ) {
          throw new Error(
            "Speaker response did not match the published view contract.",
          );
        }
        setLoadState({ projection: payload, status: "ready" });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setLoadState({ status: "error" });
      }
    }
    void loadSpeakers();
    return () => controller.abort();
  }, [fixtureState, route.eventSlug]);

  const projection = fixtureState
    ? {
        ...publicSpeakerProjectionFixture,
        speakers:
          fixtureState === "empty"
            ? []
            : publicSpeakerProjectionFixture.speakers,
      }
    : loadState.status === "ready"
      ? loadState.projection
      : undefined;
  const eventSlug = route.eventSlug ?? "ai-engineer-summit";

  if (!projection) {
    return (
      <div className="speaker-public-site">
        <a className="skip-link" href="#speaker-content">
          Skip to speakers
        </a>
        <PublicSpeakerHeader eventSlug={eventSlug} speakersCurrent />
        <PublicSpeakerState
          state={
            route.eventSlug
              ? (loadState.status as "error" | "loading" | "not-found")
              : "not-found"
          }
        />
        <PublicSpeakerFooter />
      </div>
    );
  }

  if (fixtureState === "error") {
    return (
      <div className="speaker-public-site">
        <a className="skip-link" href="#speaker-content">
          Skip to speakers
        </a>
        <PublicSpeakerHeader eventSlug={eventSlug} speakersCurrent />
        <PublicSpeakerState state="error" />
        <PublicSpeakerFooter />
      </div>
    );
  }

  const speaker = route.speakerSlug
    ? projection.speakers.find(
        (candidate) => candidate.slug === route.speakerSlug,
      )
    : undefined;

  return (
    <div className="speaker-public-site">
      <a className="skip-link" href="#speaker-content">
        Skip to speakers
      </a>
      <PublicSpeakerHeader eventSlug={projection.event.slug} speakersCurrent />
      {route.speakerSlug ? (
        speaker ? (
          <SpeakerProfile projection={projection} speaker={speaker} />
        ) : (
          <PublicSpeakerState state="not-found" />
        )
      ) : (
        <SpeakerGallery projection={projection} />
      )}
      <PublicSpeakerFooter />
    </div>
  );
}
