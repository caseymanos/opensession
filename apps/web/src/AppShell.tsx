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

import {
  ConfirmDialog,
  Drawer,
  EnvironmentBanner,
  ProductWordmark,
  ToastRegion,
  type AppEnvironment,
  type ToastMessage,
} from "@sessionbox-killer/ui";

const eventSlug = "ai-engineer-summit";

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
        <strong>AI Engineer Summit</strong>
        <small>August 18–19, 2026</small>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}

function Profile() {
  return (
    <div className="profile-chip">
      <span className="profile-avatar">CM</span>
      <span>
        <strong>Casey Manos</strong>
        <small>Organizer</small>
      </span>
    </div>
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
  onResetDemo: () => void;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const closeNavigation = useCallback(() => {
    setNavigationOpen(false);
  }, []);
  const closeReset = useCallback(() => {
    setResetOpen(false);
  }, []);

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

  function confirmReset() {
    closeReset();
    onResetDemo();
    setToasts([
      {
        id: "demo-reset",
        title: "Demo view reset",
        message: "The workspace returned to its starting screen.",
        tone: "success",
      },
    ]);
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
                setResetOpen(true);
              }}
            />
          ) : null}

          {children}
        </main>
      </div>

      <Drawer
        description="Navigate the AI Engineer Summit workspace."
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

      <ConfirmDialog
        confirmLabel="Reset demo view"
        description="Return this synthetic event workspace to its starting screen? Real event data is never included in this action."
        onClose={closeReset}
        onConfirm={confirmReset}
        open={resetOpen}
        title="Reset the demo?"
      />

      <ToastRegion
        messages={toasts}
        onDismiss={(id) => {
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }}
      />
    </>
  );
}
