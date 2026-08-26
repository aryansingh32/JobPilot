import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useCallback, useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Dashboard } from "@/components/admin/Dashboard";
import { JobsPanel } from "@/components/admin/JobsPanel";
import { UsersPanel } from "@/components/admin/UsersPanel";
import { WorkflowsPanel } from "@/components/admin/WorkflowsPanel";
import { CaptchaPanel } from "@/components/admin/CaptchaPanel";
import { BrowsersPanel } from "@/components/admin/BrowsersPanel";
import { ReliabilityPanel } from "@/components/admin/ReliabilityPanel";
import { LogsPanel, ErrorsPanel } from "@/components/admin/LogsPanel";
import { NetworkPanel } from "@/components/admin/NetworkPanel";
import { MetricsPanel } from "@/components/admin/MetricsPanel";
import { SitesPanel } from "@/components/admin/SitesPanel";
import { SecurityPanel } from "@/components/admin/SecurityPanel";
import { ObservabilityCommandCenter } from "@/components/admin/ObservabilityCommandCenter";
import { SessionIntelPanel } from "@/components/admin/SessionIntelPanel";
import { DebugCopilotPanel } from "@/components/admin/DebugCopilotPanel";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "ChatFlow Admin — System Control Panel" },
      {
        name: "description",
        content:
          "SaaS-level admin panel for full system control, user management, workflow CRUD, captcha solving, and monitoring.",
      },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const [tab, setTab] = useState("observability");
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toLocaleTimeString());
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    authClient.adminSession().then((session) => {
      if (cancelled) return;
      setAuthorized(!!session);
      if (!session) navigate({ to: "/admin/login" });
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setLastUpdated(new Date().toLocaleTimeString());
  }, []);

  const renderTab = () => {
    switch (tab) {
      case "observability":
        return <ObservabilityCommandCenter key={refreshKey} />;
      case "sessions":
        return <SessionIntelPanel key={refreshKey} />;
      case "copilot":
        return <DebugCopilotPanel key={refreshKey} />;
      case "dashboard":
        return <Dashboard key={refreshKey} />;
      case "jobs":
        return <JobsPanel key={refreshKey} />;
      case "users":
        return <UsersPanel key={refreshKey} />;
      case "workflows":
        return <WorkflowsPanel key={refreshKey} />;
      case "sites":
        return <SitesPanel key={refreshKey} />;
      case "captcha":
        return <CaptchaPanel key={refreshKey} />;
      case "browsers":
        return <BrowsersPanel key={refreshKey} />;
      case "reliability":
        return <ReliabilityPanel key={refreshKey} />;
      case "logs":
        return <LogsPanel key={refreshKey} />;
      case "errors":
        return <ErrorsPanel key={refreshKey} />;
      case "network":
        return <NetworkPanel key={refreshKey} />;
      case "metrics":
        return <MetricsPanel key={refreshKey} />;
      case "security":
        return <SecurityPanel />;
      default:
        return <Dashboard key={refreshKey} />;
    }
  };

  if (!authorized) {
    return <div className="h-screen w-screen bg-background" />;
  }

  return (
    <AdminLayout
      activeTab={tab}
      onTabChange={setTab}
      onRefresh={handleRefresh}
      lastUpdated={lastUpdated}
    >
      {renderTab()}
    </AdminLayout>
  );
}
