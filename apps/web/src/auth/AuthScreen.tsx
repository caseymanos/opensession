import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "../security/TurnstileWidget";
import {
  exchangeMagicLink,
  requestMagicLink,
  safeAuthRedirectPath,
} from "./authClient";

import "./auth-screen.css";

type RequestState = "editing" | "sending" | "sent" | "error";
type ExchangeState = "checking" | "error";

function BrandMark() {
  return (
    <a className="auth-brand" href="/" aria-label="OpenSession home">
      <span aria-hidden="true">OS</span>
      OpenSession
    </a>
  );
}

function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="Why OpenSession">
        <BrandMark />
        <div className="auth-story-copy">
          <p className="auth-eyebrow">Program operations, without the chaos</p>
          <p className="auth-story-title">
            One calm place to run your whole speaker program.
          </p>
          <p>
            Review proposals, guide speakers, catch schedule conflicts, and
            publish a polished agenda—with Airtable still visible underneath.
          </p>
        </div>
        <div className="auth-proof" aria-label="OpenSession security promise">
          <span aria-hidden="true">↗</span>
          <div>
            <strong>Passwordless by design</strong>
            <small>
              Private, one-time links. No password to reuse or reset.
            </small>
          </div>
        </div>
      </section>
      <section className="auth-action">
        <div className="auth-card">{children}</div>
        <p className="auth-footnote">
          Open source conference operations, built on Cloudflare.
        </p>
      </section>
    </main>
  );
}

function SignIn({ redirectPath }: { redirectPath: string }) {
  const [email, setEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [state, setState] = useState<RequestState>("editing");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileWidgetHandle>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    if (!turnstileToken) {
      setErrorMessage("Complete the security check before requesting a link.");
      setState("error");
      return;
    }
    setState("sending");

    try {
      await requestMagicLink({
        email,
        purpose: "sign_in",
        redirect_path: redirectPath,
        turnstile_action: "sign_in",
        turnstile_token: turnstileToken,
      });
      setState("sent");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "We couldn’t request a link just now. Please try again.",
      );
      setState("error");
    } finally {
      turnstile.current?.reset();
    }
  }

  if (state === "sent") {
    return (
      <div className="auth-result" role="status">
        <span className="auth-result-icon" aria-hidden="true">
          ✓
        </span>
        <p className="auth-kicker">Link requested</p>
        <h1>Check your inbox.</h1>
        <p>
          If <strong>{email}</strong> can sign in, a private link is on its way.
          It expires in 15 minutes and works once.
        </p>
        <button
          className="auth-secondary"
          onClick={() => {
            setTurnstileToken(null);
            setState("editing");
          }}
        >
          Use another address
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="auth-kicker">Welcome back</p>
      <h1>Sign in to your program</h1>
      <p className="auth-intro">
        Enter your work email. We’ll send a private sign-in link—no password
        needed.
      </p>
      <form className="auth-form" onSubmit={submit}>
        <label htmlFor="auth-email">Email address</label>
        <input
          autoComplete="email"
          autoFocus
          id="auth-email"
          inputMode="email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@conference.org"
          required
          type="email"
          value={email}
        />
        <TurnstileWidget
          action="sign_in"
          onTokenChange={setTurnstileToken}
          ref={turnstile}
        />
        {state === "error" ? (
          <p className="auth-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button
          className="auth-primary"
          disabled={state === "sending" || !turnstileToken}
        >
          {state === "sending"
            ? "Sending secure link…"
            : "Email me a sign-in link"}
          <span aria-hidden="true">→</span>
        </button>
      </form>
      <div className="auth-detail">
        <span aria-hidden="true">⌁</span>
        <p>
          <strong>Private and short-lived.</strong> The link can’t be replayed,
          and signing in rotates any session already in this browser.
        </p>
      </div>
    </>
  );
}

function MagicExchange() {
  const [token] = useState(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    return fragment.get("token");
  });
  const [state, setState] = useState<ExchangeState>(
    token ? "checking" : "error",
  );

  useEffect(() => {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );

    if (!token) {
      return;
    }

    const controller = new AbortController();
    void exchangeMagicLink(token, window.fetch.bind(window), controller.signal)
      .then(({ redirect_path: redirectPath }) => {
        window.location.replace(redirectPath);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setState("error");
        }
      });

    return () => controller.abort();
  }, [token]);

  return (
    <div className="auth-result" role="status">
      {state === "checking" ? (
        <>
          <span className="auth-spinner" aria-hidden="true" />
          <p className="auth-kicker">Secure sign-in</p>
          <h1>Opening your workspace…</h1>
          <p>
            We’re checking this one-time link and preparing a fresh session.
          </p>
        </>
      ) : (
        <>
          <span className="auth-result-icon is-error" aria-hidden="true">
            !
          </span>
          <p className="auth-kicker">Link unavailable</p>
          <h1>This link has expired or was already used.</h1>
          <p>Request a fresh link to continue. Your account is still safe.</p>
          <a className="auth-primary" href="/auth/sign-in">
            Request a new link <span aria-hidden="true">→</span>
          </a>
        </>
      )}
    </div>
  );
}

export function AuthScreen() {
  const exchanging = window.location.pathname === "/auth/magic";
  const redirectPath = safeAuthRedirectPath(
    new URLSearchParams(window.location.search).get("return_to"),
  );

  useEffect(() => {
    document.title = exchanging
      ? "Signing in — OpenSession"
      : "Sign in — OpenSession";
  }, [exchanging]);

  return (
    <AuthFrame>
      {exchanging ? <MagicExchange /> : <SignIn redirectPath={redirectPath} />}
    </AuthFrame>
  );
}
