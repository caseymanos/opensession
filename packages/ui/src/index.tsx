import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import {
  shouldShowDemoReset,
  shouldShowEnvironmentBanner,
  type AppEnvironment,
} from "./environment";

export type { AppEnvironment } from "./environment";

function classNames(...values: (string | false | null | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

export function ProductWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={classNames("ui-wordmark", className)}>
      <span className="ui-wordmark__mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>OpenSession</span>
    </span>
  );
}

type ButtonProps = PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary";
  }
>;

export function Button({
  children,
  className = "",
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      className={classNames("ui-button", `ui-button--${variant}`, className)}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export function StatusPill({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "neutral" | "preview" | "success" | "warning";
}) {
  return <span className={`ui-status ui-status--${tone}`}>{children}</span>;
}

export function MetricCard({
  detail,
  label,
  tone,
  value,
}: {
  detail: string;
  label: string;
  tone: "blue" | "clay" | "gold" | "ink";
  value: string;
}) {
  return (
    <article className={`ui-metric ui-metric--${tone}`}>
      <span className="ui-metric__label">{label}</span>
      <strong>{value}</strong>
      <span className="ui-metric__detail">{detail}</span>
    </article>
  );
}

export function Card({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <section className={classNames("ui-card", className)}>{children}</section>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  description?: string;
  error?: string | undefined;
  id?: string;
  label: string;
};

export function TextField({
  className,
  description,
  error,
  id: suppliedId,
  label,
  required,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ");

  return (
    <div className={classNames("ui-field", className)}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {description ? (
        <span className="ui-field__description" id={descriptionId}>
          {description}
        </span>
      ) : null}
      <input
        {...props}
        aria-describedby={describedBy || undefined}
        aria-invalid={Boolean(error)}
        id={id}
        required={required}
      />
      {error ? (
        <span className="ui-field__error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

type TextAreaFieldProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "id"
> & {
  description?: string;
  error?: string;
  id?: string;
  label: string;
};

export function TextAreaField({
  className,
  description,
  error,
  id: suppliedId,
  label,
  required,
  ...props
}: TextAreaFieldProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ");

  return (
    <div className={classNames("ui-field", className)}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {description ? (
        <span className="ui-field__description" id={descriptionId}>
          {description}
        </span>
      ) : null}
      <textarea
        {...props}
        aria-describedby={describedBy || undefined}
        aria-invalid={Boolean(error)}
        id={id}
        required={required}
      />
      {error ? (
        <span className="ui-field__error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  description?: string;
  error?: string;
  id?: string;
  label: string;
  options: { label: string; value: string }[];
};

export function SelectField({
  className,
  description,
  error,
  id: suppliedId,
  label,
  options,
  required,
  ...props
}: SelectFieldProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ");

  return (
    <div className={classNames("ui-field", className)}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {description ? (
        <span className="ui-field__description" id={descriptionId}>
          {description}
        </span>
      ) : null}
      <select
        {...props}
        aria-describedby={describedBy || undefined}
        aria-invalid={Boolean(error)}
        id={id}
        required={required}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <span className="ui-field__error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function SwitchField({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description?: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="ui-switch-field">
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <button
        aria-checked={checked}
        aria-label={label}
        className="ui-switch"
        onClick={() => {
          onChange(!checked);
        }}
        role="switch"
        type="button"
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}

export function ErrorSummary({
  errors,
  title = "There is a problem",
}: {
  errors: { fieldId: string; message: string }[];
  title?: string;
}) {
  if (errors.length === 0) {
    return null;
  }

  return (
    <section className="ui-error-summary" aria-labelledby="error-summary-title">
      <h2 id="error-summary-title">{title}</h2>
      <ul>
        {errors.map((error) => (
          <li key={`${error.fieldId}-${error.message}`}>
            <a href={`#${error.fieldId}`}>{error.message}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export type ViewState = "empty" | "error" | "loading" | "permission";

const stateLabels: Record<ViewState, string> = {
  empty: "Nothing here yet",
  error: "We could not load this view",
  loading: "Loading",
  permission: "You do not have access",
};

export function StatePanel({
  action,
  description,
  onRetry,
  state,
  title = stateLabels[state],
}: {
  action?: ReactNode;
  description: string;
  onRetry?: (() => void) | undefined;
  state: ViewState;
  title?: string;
}) {
  const isLoading = state === "loading";

  return (
    <section
      className={classNames("ui-state", `ui-state--${state}`)}
      aria-busy={isLoading || undefined}
      aria-live={isLoading ? "polite" : undefined}
    >
      <span className="ui-state__mark" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {isLoading ? (
        <div className="ui-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      {action}
    </section>
  );
}

export interface DataTableColumn<Row> {
  header: string;
  key: string;
  render: (row: Row) => ReactNode;
}

export function DataTable<Row>({
  caption,
  columns,
  emptyDescription = "No results match the current filters.",
  getRowKey,
  rows,
}: {
  caption: string;
  columns: DataTableColumn<Row>[];
  emptyDescription?: string;
  getRowKey: (row: Row) => string;
  rows: Row[];
}) {
  if (rows.length === 0) {
    return <StatePanel state="empty" description={emptyDescription} />;
  }

  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((column) => (
                <td data-label={column.header} key={column.key}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

function useModalFocus({
  onClose,
  open,
}: {
  onClose: () => void;
  open: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !surfaceRef.current) {
      return;
    }

    const surface = surfaceRef.current;
    const restoreTarget =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusable = getFocusableElements(surface);
    (focusable[0] ?? surface).focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const currentFocusable = getFocusableElements(surface);
      const first = currentFocusable[0];
      const last = currentFocusable.at(-1);

      if (!first || !last) {
        event.preventDefault();
        surface.focus();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    surface.addEventListener("keydown", handleKeyDown);

    return () => {
      surface.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreTarget?.focus();
    };
  }, [onClose, open]);

  return surfaceRef;
}

function Overlay({
  children,
  description,
  kind,
  onClose,
  open,
  title,
}: PropsWithChildren<{
  description?: string;
  kind: "dialog" | "drawer";
  onClose: () => void;
  open: boolean;
  title: string;
}>) {
  const titleId = useId();
  const descriptionId = useId();
  const surfaceRef = useModalFocus({ onClose, open });

  if (!open) {
    return null;
  }

  return (
    <div
      className={classNames("ui-overlay", `ui-overlay--${kind}`)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={classNames("ui-overlay__surface", `ui-${kind}`)}
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="ui-overlay__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button
            className="ui-overlay__close"
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="ui-overlay__content">{children}</div>
      </div>
    </div>
  );
}

export function Dialog(
  props: PropsWithChildren<{
    description?: string;
    onClose: () => void;
    open: boolean;
    title: string;
  }>,
) {
  return <Overlay {...props} kind="dialog" />;
}

export function Drawer(
  props: PropsWithChildren<{
    description?: string;
    onClose: () => void;
    open: boolean;
    title: string;
  }>,
) {
  return <Overlay {...props} kind="drawer" />;
}

export function ConfirmDialog({
  cancelLabel = "Cancel",
  confirmLabel,
  description,
  onClose,
  onConfirm,
  open,
  title,
}: {
  cancelLabel?: string;
  confirmLabel: string;
  description: string;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <Dialog
      description={description}
      onClose={onClose}
      open={open}
      title={title}
    >
      <div className="ui-confirm-actions">
        <Button variant="secondary" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}

export interface ToastMessage {
  id: string;
  message: string;
  title: string;
  tone?: "error" | "success";
}

export function ToastRegion({
  messages,
  onDismiss,
}: {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  return (
    <section
      className="ui-toast-region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {messages.map((message) => (
        <article
          className={classNames(
            "ui-toast",
            message.tone && `ui-toast--${message.tone}`,
          )}
          key={message.id}
          role={message.tone === "error" ? "alert" : "status"}
        >
          <div>
            <strong>{message.title}</strong>
            <p>{message.message}</p>
          </div>
          <button
            type="button"
            aria-label={`Dismiss ${message.title}`}
            onClick={() => {
              onDismiss(message.id);
            }}
          >
            ×
          </button>
        </article>
      ))}
    </section>
  );
}

export function LiveRegion({ message }: { message: string }) {
  return (
    <p className="ui-sr-only" aria-live="polite" aria-atomic="true">
      {message}
    </p>
  );
}

export function EnvironmentBanner({
  environment,
  isDemoEvent,
  onReset,
}: {
  environment: AppEnvironment;
  isDemoEvent: boolean;
  onReset?: () => void;
}) {
  if (!shouldShowEnvironmentBanner({ environment, isDemoEvent })) {
    return null;
  }

  const resetVisible = shouldShowDemoReset({ isDemoEvent, onReset });
  const environmentLabel =
    environment === "production" ? "Production demo" : environment;

  return (
    <section className="ui-environment" aria-label="Environment status">
      <StatusPill tone={isDemoEvent ? "warning" : "preview"}>
        {environmentLabel}
      </StatusPill>
      <div>
        <strong>
          {isDemoEvent
            ? "You are working with synthetic data"
            : "Safe workspace"}
        </strong>
        <span>
          {isDemoEvent
            ? "Changes here never affect a real event."
            : "This environment is isolated from production."}
        </span>
      </div>
      {resetVisible ? (
        <Button
          className="ui-environment__reset"
          variant="secondary"
          onClick={onReset}
        >
          Reset demo
        </Button>
      ) : null}
    </section>
  );
}
