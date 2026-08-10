import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  turnstileConfigResponseSchema,
  type TurnstileAction,
} from "@sessionbox-killer/contracts";

import "./turnstile-widget.css";

const scriptUrl =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  remove(widgetId: string): void;
  render(
    container: HTMLElement,
    options: {
      action: TurnstileAction;
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      sitekey: string;
      theme: "light";
    },
  ): string;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  const promise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${scriptUrl}"]`,
    );
    const script = existing ?? document.createElement("script");
    const loaded = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile did not initialize."));
    };
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener(
      "error",
      () => {
        script.remove();
        reject(new Error("Turnstile could not load."));
      },
      { once: true },
    );
    if (!existing) {
      script.async = true;
      script.defer = true;
      script.src = scriptUrl;
      document.head.append(script);
    }
  }).catch((error: unknown) => {
    scriptPromise = null;
    throw error;
  });
  scriptPromise = promise;
  return promise;
}

async function loadSiteKey(signal: AbortSignal): Promise<string> {
  const response = await fetch("/api/v1/public/security/turnstile", {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error("Turnstile configuration is unavailable.");
  const parsed = turnstileConfigResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Turnstile configuration is invalid.");
  return parsed.data.site_key;
}

export interface TurnstileWidgetHandle {
  reset(): void;
}

interface TurnstileWidgetProps {
  action: TurnstileAction;
  onTokenChange: (token: string | null) => void;
}

export const TurnstileWidget = forwardRef<
  TurnstileWidgetHandle,
  TurnstileWidgetProps
>(function TurnstileWidget({ action, onTokenChange }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onTokenChange);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    callback.current = onTokenChange;
  }, [onTokenChange]);

  useImperativeHandle(ref, () => ({
    reset() {
      callback.current(null);
      if (widget.current) widget.current.api.reset(widget.current.id);
    },
  }));

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState("loading");
    callback.current(null);

    void Promise.all([loadTurnstile(), loadSiteKey(controller.signal)])
      .then(([api, sitekey]) => {
        if (!active || !container.current) return;
        const id = api.render(container.current, {
          action,
          callback: (token) => callback.current(token),
          "error-callback": () => {
            callback.current(null);
            setState("error");
          },
          "expired-callback": () => callback.current(null),
          sitekey,
          theme: "light",
        });
        widget.current = { api, id };
        setState("ready");
      })
      .catch((error: unknown) => {
        if (
          active &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setState("error");
        }
      });

    return () => {
      active = false;
      controller.abort();
      if (widget.current) {
        widget.current.api.remove(widget.current.id);
        widget.current = null;
      }
    };
  }, [action, attempt]);

  return (
    <div className="turnstile-control">
      <div ref={container} />
      {state === "loading" ? (
        <p role="status">Loading security check…</p>
      ) : null}
      {state === "error" ? (
        <div className="turnstile-error" role="alert">
          <span>The security check could not load.</span>
          <button
            onClick={() => setAttempt((value) => value + 1)}
            type="button"
          >
            Try security check again
          </button>
        </div>
      ) : null}
    </div>
  );
});
