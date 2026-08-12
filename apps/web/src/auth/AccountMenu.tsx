import { ChevronDown, LogOut } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { logoutAuthSession } from "./authClient";

import "./account-menu.css";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("en-US") ?? "")
    .join("");
}

export function AccountMenu({
  className,
  displayName,
  placement,
  roleLabel,
}: {
  className: string;
  displayName: string;
  placement: "sidebar" | "topbar";
  roleLabel: string;
}) {
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const signOutItem = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!open) return;
    signOutItem.current?.focus();

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
        setError("");
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [open]);

  function closeFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    setError("");
    trigger.current?.focus();
  }

  function openFromKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setOpen(true);
    setError("");
  }

  async function signOut() {
    if (signingOut) return;
    setError("");
    setSigningOut(true);
    try {
      await logoutAuthSession(document.cookie);
      window.location.assign("/auth/sign-in");
    } catch (signOutError) {
      setError(
        signOutError instanceof Error
          ? signOutError.message
          : "We couldn’t sign you out. Refresh and try again.",
      );
      setSigningOut(false);
    }
  }

  return (
    <div
      className={`account-menu account-menu--${placement} ${className}`}
      onKeyDownCapture={closeFromKeyboard}
      ref={container}
    >
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${displayName} account`}
        className="account-menu__trigger"
        onClick={() => {
          setOpen((current) => !current);
          setError("");
        }}
        onKeyDown={openFromKeyboard}
        ref={trigger}
        type="button"
      >
        <span className="account-menu__avatar" aria-hidden="true">
          {initials(displayName)}
        </span>
        <span className="account-menu__identity">
          <strong>{displayName}</strong>
          <small>{roleLabel}</small>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="account-menu__chevron"
          size={15}
        />
      </button>
      {open ? (
        <div className="account-menu__popover">
          <div className="account-menu__items" id={menuId} role="menu">
            <button
              disabled={signingOut}
              onClick={() => void signOut()}
              ref={signOutItem}
              role="menuitem"
              type="button"
            >
              <LogOut aria-hidden="true" size={16} />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
          {error ? (
            <p className="account-menu__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
