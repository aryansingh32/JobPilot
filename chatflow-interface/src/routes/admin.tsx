import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useCallback, useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Dashboard } from "@/components/admin/Dashboard";
import { JobsPanel } from "@/components/admin/JobsPanel";
import { UsersPanel } from "@/components/admin/UsersPanel";
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
import { ApplicationsPanel } from "@/components/admin/ApplicationsPanel";
import { JobSourcesPanel } from "@/components/admin/JobSourcesPanel";
import { WorkflowStudio } from "@/components/admin/WorkflowStudio";
import { RecorderPanel } from "@/components/admin/RecorderPanel";
import {
  AiUsagePanel,
  InboxPanel,
  SettingsPanel,
  TeamPanel,
  TestProfilePanel,
} from "@/components/admin/PlatformPanels";
import { AnswerDefaultsPanel } from "@/components/admin/AnswerDefaultsPanel";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "JobPilot Admin" },
      {
        name: "description",
        content:
          "Control panel for applications, job sources, workflows, the recorder, settings and monitoring.",
      },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const [tab, setTab] = useState(() => {
    if (typeof window === "undefined") return "dashboard";
    try {
      return window.location.hash.slice(1) || localStorage.getItem("jp-admin-tab") || "dashboard";
    } catch {
      return "dashboard";
    }
  });
  // Back/forward and pasted #links switch panels too.
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1);
      if (h) setTab(h);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("jp-admin-tab", tab);
      if (window.location.hash.slice(1) !== tab) window.history.pushState(null, "", `#${tab}`);
    } catch {
      /* storage blocked */
    }
  }, [tab]);
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
        return <WorkflowStudio key={refreshKey} />;
      case "recorder":
        return <RecorderPanel />;
      case "test-profile":
        return <TestProfilePanel key={refreshKey} />;
      case "applications":
        return <ApplicationsPanel key={refreshKey} />;
      case "sources":
        return <JobSourcesPanel key={refreshKey} />;
      case "inbox":
        return <InboxPanel key={refreshKey} />;
      case "answers":
        return <AnswerDefaultsPanel key={refreshKey} />;
      case "settings":
        return <SettingsPanel key={refreshKey} />;
      case "ai":
        return <AiUsagePanel key={refreshKey} />;
      case "team":
        return <TeamPanel key={refreshKey} />;
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
