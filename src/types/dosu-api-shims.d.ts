/**
 * Type shims for cross-repo @dosu/api type resolution.
 * These stub missing global types from the main project's type chain.
 * Will be unnecessary once @dosu/api-types npm package is published.
 */

// Global type from @dosu/core/types/core.d.ts
declare type Nullable<T> = T | null | undefined;

// Email template type from @dosu/api/emails
declare type EmailFC<P = Record<string, unknown>> = React.FC<P> & {
  PreviewProps?: P;
};
