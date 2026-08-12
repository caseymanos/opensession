import {
  demoEventDateLabel,
  demoEventName,
  demoEventSlug,
  demoResetPhrase,
} from "@sessionbox-killer/domain";
import { useCallback, useState, type ReactNode } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Command,
  FileCheck2,
  FileText,
  Globe2,
  Inbox,
  LayoutDashboard,
  Mail,
  Menu,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Users,
} from "lucide-react";
import type { DemoResetResponse } from "@sessionbox-killer/contracts";

import { AccountMenu } from "./auth/AccountMenu";
import { DemoResetApiError } from "./demo/demoClient";
import {
  Button,
  Dialog,
  Drawer,
  EnvironmentBanner,
  ProductWordmark,
  TextField,
  ToastRegion,
  type AppEnvironment,
  type ToastMessage,
} from "@sessionbox-killer/ui";

const eventSlug = demoEventSlug;

const navigation = [
  {
    label: "Collect",
    items: [
      {
        label: "Home",
        href: `/app/${eventSlug}/home`,
        icon: LayoutDashboard,
      },
      { label: "CFP", href: `/app/${eventSlug}/cfp`, icon: FileText },
      {
        label: "Submissions",
        href: `/app/${eventSlug}/submissions`,
        icon: Inbox,
        count: "12",
      },
    ],
  },
  {
    label: "Decide",
    items: [
      {
        label: "Reviews",
        href: `/app/${eventSlug}/reviews`,
        icon: Sparkles,
        count: "8",
      },
      {
        label: "Decisions",
        href: `/app/${eventSlug}/decisions`,
        icon: FileCheck2,
      },
    ],
  },
  {
    label: "Prepare",
    items: [
      { label: "People", href: `/app/${eventSlug}/people`, icon: Users },
      {
        label: "Tasks",
        href: `/app/${eventSlug}/tasks`,
        icon: CheckCircle2,
      },
      {
        label: "Communications",
        href: `/app/${eventSlug}/communications`,
        icon: Mail,
      },
    ],
  },
  {
    label: "Publish",
    items: [
      {
        label: "Agenda",
        href: `/app/${eventSlug}/agenda`,
        icon: CalendarDays,
      },
      {
        label: "Public program",
        href: `/e/${eventSlug}`,
        icon: Globe2,
      },
    ],
  },
  {
    label: "Configure",
    items: [
      {
        label: "Event settings",
        href: `/app/${eventSlug}/settings`,
        icon: Settings2,
      },
      {
        label: "Integrations",
        href: `/app/${eventSlug}/integrations`,
        icon: SlidersHorizontal,
      },
    ],
  },
] as const;

function Brand() {
  return <ProductWordmark className="brand" />;
}

function EventSwitcher() {
  return (
    <button className="event-switcher" type="button">
      <span className="event-avatar">AS</span>
      <span>
        <strong>{demoEventName}</strong>
        <small>{demoEventDateLabel}</small>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}

function Profile() {
  return (
    <AccountMenu
      className="profile-chip"
      displayName="Casey Manos"
      placement="sidebar"
      roleLabel="Organizer"
    />
  );
}

function PrimaryNavigation({
  onNavigate,
}: {
  onNavigate?: (() => void) | undefined;
}) {
  const currentPath = window.location.pathname;

  return (
    <nav aria-label="Primary navigation">
      {navigation.map((group) => (
        <section className="nav-group" key={group.label}>
          <h2>{group.label}</h2>
          {group.items.map((item) => {
            const Icon = item.icon;
            const current =
              currentPath === item.href ||
              (item.label === "Communications" &&
                currentPath.startsWith(`${item.href}/`)) ||
              (item.label === "Home" && currentPath === "/");

            return (
              <a
                className={current ? "nav-item is-current" : "nav-item"}
                href={item.href}
                aria-current={current ? "page" : undefined}
                key={item.label}
                onClick={onNavigate}
              >
                <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                <span>{item.label}</span>
                {"count" in item ? (
                  <span
                    className="nav-count"
                    aria-label={`${item.count} items`}
                  >
                    {item.count}
                  </span>
                ) : null}
              </a>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

function SidebarContent({
  onNavigate,
}: {
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <>
      <Brand />
      <EventSwitcher />
      <PrimaryNavigation onNavigate={onNavigate} />
      <div className="sidebar-footer">
        <Profile />
      </div>
    </>
  );
}

export function AppShell({
  children,
  environment,
  isDemoEvent,
  onResetDemo,
}: {
  children: ReactNode;
  environment: AppEnvironment | null;
  isDemoEvent: boolean;
  onResetDemo: (confirmation: string) => Promise<DemoResetResponse>;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [resetError, setResetError] = useState<string | undefined>();
  const [resetPending, setResetPending] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const closeNavigation = useCallback(() => {
    setNavigationOpen(false);
  }, []);
  const closeReset = useCallback(() => {
    if (resetPending) return;
    setResetOpen(false);
    setResetConfirmation("");
    setResetError(undefined);
  }, [resetPending]);

  function showSearchNotice() {
    setToasts([
      {
        id: "search-coming-soon",
        title: "Search is almost ready",
        message:
          "The command surface is included now; indexed search lands with feature data.",
      },
    ]);
  }

  async function confirmReset() {
    if (resetConfirmation !== demoResetPhrase || resetPending) return;
    setResetPending(true);
    setResetError(undefined);
    try {
      const result = await onResetDemo(resetConfirmation);
      setResetOpen(false);
      setResetConfirmation("");
      setToasts([
        {
          id: "demo-reset",
          title: "Demo data reset",
          message: `${result.receipt.operation_count} authoritative records restored from ${result.receipt.snapshot_id} · digest ${result.receipt.digest.slice(0, 12)}… · reset run ${result.receipt.reset_run_id}`,
          tone: "success",
        },
      ]);
    } catch (error) {
      setResetError(
        error instanceof Error
          ? error.message
          : "The demo could not be reset. Try again.",
      );
      setToasts([
        {
          id: "demo-reset-failed",
          title: "Demo reset did not finish",
          message: `Your existing demo data was left in a recoverable state.${
            error instanceof DemoResetApiError && error.requestId
              ? ` Reference ${error.requestId}.`
              : ""
          }`,
          tone: "error",
        },
      ]);
    } finally {
      setResetPending(false);
    }
  }

  return (
    <>
      <a className="skip-link" href="#workspace">
        Skip to main content
      </a>
      <div className="app-frame">
        <aside className="sidebar" aria-label="Event workspace">
          <SidebarContent />
        </aside>

        <main id="workspace" tabIndex={-1}>
          <header className="topbar">
            <button
              className="mobile-menu"
              type="button"
              aria-expanded={navigationOpen}
              aria-label="Open navigation"
              onClick={() => {
                setNavigationOpen(true);
              }}
            >
              <Menu size={20} aria-hidden="true" />
            </button>
            <button
              className="command-search"
              type="button"
              aria-label="Search people, sessions, and submissions"
              onClick={showSearchNotice}
            >
              <Search size={17} aria-hidden="true" />
              <span>Search people, sessions, submissions…</span>
              <kbd>
                <Command size={12} aria-hidden="true" /> K
              </kbd>
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Help and support"
            >
              <CircleHelp size={19} aria-hidden="true" />
            </button>
          </header>

          {environment ? (
            <EnvironmentBanner
              environment={environment}
              isDemoEvent={isDemoEvent}
              onReset={() => {
                setResetConfirmation("");
                setResetError(undefined);
                setResetOpen(true);
              }}
            />
          ) : null}

          {children}
        </main>
      </div>

      <Drawer
        description={`Navigate the ${demoEventName} workspace.`}
        onClose={closeNavigation}
        open={navigationOpen}
        title="Event navigation"
      >
        <div className="mobile-navigation">
          <EventSwitcher />
          <PrimaryNavigation onNavigate={closeNavigation} />
          <Profile />
        </div>
      </Drawer>

      <Dialog
        description="Replace this synthetic event with the compiled starting snapshot. The guard cannot target a real event."
        onClose={closeReset}
        open={resetOpen}
        title="Reset all demo data?"
      >
        <TextField
          autoComplete="off"
          description={`Type ${demoResetPhrase} to confirm.`}
          disabled={resetPending}
          error={resetError}
          label="Confirmation phrase"
          onChange={(event) => {
            setResetConfirmation(event.currentTarget.value);
            setResetError(undefined);
          }}
          value={resetConfirmation}
        />
        <div className="ui-confirm-actions">
          <Button
            disabled={resetPending}
            variant="secondary"
            onClick={closeReset}
          >
            Cancel
          </Button>
          <Button
            disabled={resetPending || resetConfirmation !== demoResetPhrase}
            onClick={() => void confirmReset()}
          >
            {resetPending ? "Resetting…" : "Reset demo data"}
          </Button>
        </div>
      </Dialog>

      <ToastRegion
        messages={toasts}
        onDismiss={(id) => {
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }}
      />
    </>
  );
}
