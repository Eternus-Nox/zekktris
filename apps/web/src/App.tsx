/**
 * App
 * ---
 * Top-level routing + provider stack.
 *
 * Provider order matters: AppStateProvider depends on AuthContext (it reads
 * the rest+gateway clients), so it must be inside AuthProvider.
 */

import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage } from './auth/AuthScreens';
import { Shell } from './app/Shell';
import { ConfirmEmailPage } from './app/ConfirmEmailPage';
import { VerifyEmailPage } from './app/VerifyEmail';
import { InvitePage } from './app/InvitePage';
import { TermsPage, PrivacyPage } from './app/LegalPage';
import { AppStateProvider } from './state/AppState';
import { TypingProvider } from './state/Typing';
import { ToastProvider } from './state/Toasts';
import { ErrorBoundary } from './lib/ErrorBoundary';
import { PwaBanners } from './app/PwaBanners';
import { DobBanner } from './app/DobBanner';

/**
 * Picks the wrapper for `/invite/:code` based on auth state.
 *
 * Authenticated visitors get the Shell wrapper so the guild rail
 * shows alongside the invite card (matching the discover/admin/
 * mentions/settings pattern). Anonymous visitors get the standalone
 * InvitePage — full-page-takeover with sign-in / sign-up CTAs — so
 * the "preview before signing up" feature still works.
 *
 * Lives here rather than inside InvitePage because we want the
 * Shell wrapper to mount (hooks + chrome) for authed users, and
 * NOT to mount for anonymous users (Shell's auth-gate would redirect
 * to /login, skipping the preview).
 */
function InviteRoute() {
  const { token } = useAuth();
  return token ? <Shell /> : <InvitePage />;
}

export function App() {
  return (
    // Top-level ErrorBoundary catches ANY render error from anywhere
    // in the tree. Without this a single bad component greys-screens
    // the entire app, leaving the user no recourse but a hard refresh.
    // With it, they see the error message and a retry button — and
    // we get a console log of the stack trace for debugging. Multiple
    // smaller boundaries (e.g. around each MessageItem) still wrap
    // hot leaves where we want failure to be inline rather than
    // app-wide; this top-level one is the safety net for everything
    // else (MessageView, Shell chrome, modals, etc).
    <ErrorBoundary
      fallback={(err) => (
        <div className="min-h-screen flex items-center justify-center bg-bg-1 text-ink-1 p-6">
          <div className="max-w-md w-full bg-bg-2 border border-line rounded-lg p-6">
            <h1 className="text-lg font-semibold text-red-300 mb-2">Something broke.</h1>
            <p className="text-sm text-ink-2 mb-4">
              An unexpected error happened while rendering. Try reloading; if it
              persists, the message below should help diagnose.
            </p>
            <pre className="text-xs font-mono text-ink-3 bg-bg-1 border border-line rounded p-3 overflow-auto whitespace-pre-wrap break-words">
              {err.message || 'Unknown error'}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium"
            >
              Reload
            </button>
          </div>
        </div>
      )}
    >
      <ToastProvider>
        <AuthProvider>
          <AppStateProvider>
            <TypingProvider>
              <PwaBanners />
              <DobBanner />
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                <Route path="/terms" element={<TermsPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/invite/:code" element={<InviteRoute />} />
                <Route path="/admin" element={<Shell />} />
                <Route path="/mentions" element={<Shell />} />
                <Route path="/settings" element={<Shell />} />
                <Route path="/family" element={<Shell />} />
                <Route path="/friends" element={<Shell />} />
                <Route path="/events" element={<Shell />} />
                <Route path="/saved" element={<Shell />} />
                <Route path="/scheduled" element={<Shell />} />
                <Route path="/confirm-email" element={<ConfirmEmailPage />} />
                <Route path="/verify-email" element={<VerifyEmailPage />} />
                <Route path="/create-server" element={<Shell />} />
                <Route path="/join-server" element={<Shell />} />
                <Route path="/" element={<Shell />} />
                <Route path="/channels/:guildId" element={<Shell />} />
                <Route path="/channels/:guildId/:channelId" element={<Shell />} />
                <Route path="/channels/:guildId/:channelId/:messageId" element={<Shell />} />
                <Route path="/discover" element={<Shell />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </TypingProvider>
          </AppStateProvider>
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
