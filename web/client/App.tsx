import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppLayout } from "@/components/AppLayout";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import DevViewPage from "@/pages/DevViewPage";
import PublicView from "@/pages/PublicView";
import PublicArticleView from "@/pages/PublicArticleView";
import PublicOpenArticleView from "@/pages/PublicOpenArticleView";
import SeoView from "@/pages/SeoView";
import EditOutline from "@/pages/EditOutline";
import AdminDashboard from "@/pages/AdminDashboard";
import { User, onAuthStateChange } from "@/lib/auth";
import { initializeVersion } from "@/lib/version";

const queryClient = new QueryClient();

function AuthContent() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Development mode: skip authentication on localhost and preview URLs
  const isDevelopment =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname.includes("fly.dev") ||
      window.location.hostname.includes("localhost:"));

  // Initialize version tracking
  useEffect(() => {
    initializeVersion();
  }, []);

  useEffect(() => {
    if (isDevelopment) {
      // In development, automatically set a mock user
      setUser({
        id: "dev-user",
        email: "dev@example.com",
      });
      setIsLoading(false);
      return;
    }

    // Only set up auth state listener in production
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = onAuthStateChange((currentUser) => {
        setUser(currentUser);
        setIsLoading(false);
      });
    } catch (error) {
      console.warn("Auth state listener error (development mode):", error);
      setIsLoading(false);
    }

    return () => unsubscribe?.();
  }, [isDevelopment]);

  // Determine if we're on a share/public route FIRST (before checking loading state)
  const isShareRoute = window.location.pathname.startsWith("/share/");
  const isPublicArticleRoute =
    window.location.pathname.startsWith("/share-article/") ||
    window.location.pathname.startsWith("/article/");

  // Public routes that don't require authentication - serve immediately without waiting for auth
  if (isShareRoute || isPublicArticleRoute) {
    return (
      <Routes>
        <Route path="/share/:clientName/:keyword" element={<PublicView />} />
        <Route
          path="/share-article/:articleId"
          element={<PublicOpenArticleView />}
        />
        <Route path="/article/:articleId" element={<PublicArticleView />} />
      </Routes>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-border border-t-primary"></div>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      {/* Authentication and protected routes */}
      {!user ? (
        <>
          <Route
            path="/register"
            element={<Register onSwitchToLogin={() => navigate("/")} />}
          />
          <Route
            path="/forgot-password"
            element={<ForgotPassword onSwitchToLogin={() => navigate("/")} />}
          />
          <Route
            path="/reset-password"
            element={<ResetPassword onComplete={() => navigate("/")} />}
          />
          <Route
            path="*"
            element={
              <Login
                onSwitchToRegister={() => navigate("/register")}
                onSwitchToForgotPassword={() => navigate("/forgot-password")}
              />
            }
          />
        </>
      ) : (
        <>
          <Route
            path="/"
            element={<AppLayout onLogout={() => setUser(null)} />}
          />
          <Route path="/edit/:id" element={<EditOutline />} />
          <Route
            path="/editor/:projectId"
            element={<AppLayout onLogout={() => setUser(null)} />}
          />
          <Route path="/editor/:projectId/seo" element={<SeoView />} />
          <Route
            path="/client/:clientName"
            element={<AppLayout onLogout={() => setUser(null)} />}
          />
          <Route
            path="/create"
            element={<AppLayout onLogout={() => setUser(null)} />}
          />
          <Route
            path="/settings/*"
            element={<AppLayout onLogout={() => setUser(null)} />}
          />
          <Route path="/dev-view" element={<DevViewPage />} />
          <Route path="/client-view" element={<DevViewPage />} />
          <Route path="/admin" element={<AdminDashboard />} />
        </>
      )}
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <AuthContent />
        </TooltipProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}
