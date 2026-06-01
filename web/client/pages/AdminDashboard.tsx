import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Users, FileText, Plus, Lock, ExternalLink, Download, Send, Upload, AlertTriangle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { getArticleOutlines } from "@/lib/storage";
import { getCurrentUser } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { getAllUserUneditedArticles, sendToWebhook } from "@/lib/unedited-articles";
import { getEditingFeedback, type EditingFeedbackData } from "@/lib/editing-feedback";
import { trackedTimeAnomaly, formatSecondsAsHM } from "@/lib/tracked-time";

import {
  getTeamMembers,
  addTeamMember,
  updateTeamMemberRole,
  removeTeamMember,
  TeamMember,
  getUserRole,
} from "@/lib/team-members";
import { deleteUserAndDataFromAuth } from "@/lib/admin";
import BatchGenerateTab from "@/components/BatchGenerateTab";
import { BatchActivityBanner } from "@/components/BatchActivityBanner";
import { ArticleOutline } from "@/types/article";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";

// CSV export helper for the editor-feedback table. Mirrors only the columns
// visible in the UI (Article Title, User, Feedback Date, Reported Time,
// Version, Original/Final article URLs, Issues). Tracked Time is captured in
// the DB but intentionally excluded — it's hidden in the UI and the export
// should match what editors and admins actually see.
function exportFeedbackToCsv(rows: EditingFeedbackData[]) {
  const headers = [
    "Article Title",
    "User",
    "Feedback Date",
    "Reported Time",
    "Version",
    "Original Article URL",
    "Final Article URL",
    "Issues",
  ];
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.map(escape).join(",")];
  for (const r of rows) {
    const articleId =
      r.articleId || r.articleLink?.match(/\/editor\/([^/?]+)/)?.[1] || "";
    const originalUrl = articleId
      ? `${origin}/share-article/${articleId}?original=true`
      : "";
    const finalUrl = articleId ? `${origin}/share-article/${articleId}` : "";
    const date = r.createdAt
      ? new Date(r.createdAt).toLocaleDateString()
      : "";
    lines.push(
      [
        r.articleTitle,
        r.userEmail,
        date,
        r.timeSpent,
        r.version || "",
        originalUrl,
        finalUrl,
        r.issues,
      ]
        .map(escape)
        .join(","),
    );
  }
  // UTF-8 BOM so Excel opens it without garbling Vietnamese / accented text.
  const BOM = "﻿";
  const blob = new Blob([BOM + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `meerkat-feedback-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();

  // Authorization state
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // Controlled active tab so the BatchActivityBanner can navigate to the
  // Batch Generate tab on click.
  const [activeTab, setActiveTab] = useState<string>("articles");

  // Articles state
  const [articles, setArticles] = useState<ArticleOutline[]>([]);
  const [filteredArticles, setFilteredArticles] = useState<ArticleOutline[]>(
    [],
  );
  const [keywordFilter, setKeywordFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [memberFilter, setMemberFilter] = useState("");
  const [articlesLoading, setArticlesLoading] = useState(true);


  // Team members state
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"admin" | "member">(
    "member",
  );
  const [addingMember, setAddingMember] = useState(false);

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteAuthConfirm, setDeleteAuthConfirm] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const [deletingFromAuth, setDeletingFromAuth] = useState(false);
  const [deleteAuthEmail, setDeleteAuthEmail] = useState("");

  // Webhook sending state
  const [sendingToWebhook, setSendingToWebhook] = useState(false);

  // Editing feedback state
  const [editingFeedback, setEditingFeedback] = useState<EditingFeedbackData[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(true);
  const [expandedFeedback, setExpandedFeedback] = useState<Set<string>>(new Set());

  const toggleFeedbackExpand = (id: string) => {
    setExpandedFeedback((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Check authorization
  useEffect(() => {
    const checkAuthorization = async () => {
      try {
        const user = await getCurrentUser();
        if (!user) {
          setIsAuthorized(false);
          setCurrentUserId(null);
          return;
        }

        setCurrentUserId(user.id);

        let role = await getUserRole(user.id);

        // If getUserRole fails, try direct Supabase query as fallback
        if (!role) {
          console.log("⚠️ getUserRole failed, trying direct Supabase query...");
          try {
            const { data, error } = await supabase
              .from("team_members")
              .select("role")
              .eq("user_id", user.id)
              .single();

            if (data) {
              role = data.role as "admin" | "member";
              console.log("✅ Got role from direct Supabase query:", role);
            } else if (error) {
              console.warn(
                "⚠️ No team member record found for user:",
                user.id,
                error,
              );
            }
          } catch (err) {
            console.warn("⚠️ Direct Supabase query also failed:", err);
          }
        }

        if (role === "admin") {
          setIsAuthorized(true);
        } else if (!role) {
          // If role lookup completely fails, allow admin dashboard access anyway
          // The /api/team-members endpoint may be temporarily unavailable
          // In production, this should require explicit admin verification
          console.warn(
            "⚠️ Role lookup failed, allowing access to admin dashboard anyway",
          );
          setIsAuthorized(true);
        } else {
          setIsAuthorized(false);
        }
      } catch (error) {
        console.error("Error checking authorization:", error);
        setIsAuthorized(false);
        setCurrentUserId(null);
      }
    };

    checkAuthorization();
  }, []);

  // Load articles
  useEffect(() => {
    // Only load if authorized
    if (isAuthorized === false) return;

    const loadArticles = async () => {
      try {
        setArticlesLoading(true);
        // Admin dashboard: admins can see all articles from all users
        const data = await getArticleOutlines({
          userId: currentUserId || undefined,
          userRole: "admin",
        });
        setArticles(data);
      } catch (error) {
        console.error("Error loading articles:", error);
        toast({
          title: "Error",
          description: "Failed to load articles",
          variant: "destructive",
        });
      } finally {
        setArticlesLoading(false);
      }
    };

    loadArticles();
  }, [toast, isAuthorized, currentUserId]);


  // Load team members
  useEffect(() => {
    // Only load if authorized
    if (isAuthorized === false) return;

    const loadTeamMembers = async () => {
      try {
        setMembersLoading(true);
        const data = await getTeamMembers();
        setTeamMembers(data);
      } catch (error) {
        console.error("Error loading team members:", error);
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Don't show error for network issues - gracefully degrade
        if (
          !errorMsg.includes("Failed to fetch") &&
          !errorMsg.includes("Network")
        ) {
          toast({
            title: "Error",
            description: "Failed to load team members",
            variant: "destructive",
          });
        }

        setTeamMembers([]);
      } finally {
        setMembersLoading(false);
      }
    };

    loadTeamMembers();
  }, [toast, isAuthorized]);

  // Load editing feedback
  useEffect(() => {
    // Only load if authorized
    if (isAuthorized === false) return;

    const loadEditingFeedback = async () => {
      try {
        setFeedbackLoading(true);
        const data = await getEditingFeedback();
        setEditingFeedback(data);
      } catch (error) {
        console.error("Error loading editing feedback:", error);
        toast({
          title: "Error",
          description: "Failed to load editing feedback",
          variant: "destructive",
        });
      } finally {
        setFeedbackLoading(false);
      }
    };

    loadEditingFeedback();
  }, [isAuthorized, toast]);

  // Filter articles
  useEffect(() => {
    let filtered = articles;

    if (keywordFilter) {
      filtered = filtered.filter((article) =>
        article.keyword.toLowerCase().includes(keywordFilter.toLowerCase()),
      );
    }

    if (clientFilter) {
      filtered = filtered.filter((article) =>
        article.clientName.toLowerCase().includes(clientFilter.toLowerCase()),
      );
    }

    if (memberFilter) {
      filtered = filtered.filter((article) => article.userId === memberFilter);
    }

    setFilteredArticles(filtered);
  }, [articles, keywordFilter, clientFilter, memberFilter]);


  // Handle adding team member
  const handleAddMember = async () => {
    if (!newMemberEmail.trim()) {
      toast({
        title: "Error",
        description: "Please enter an email address",
        variant: "destructive",
      });
      return;
    }

    try {
      setAddingMember(true);
      await addTeamMember(newMemberEmail, newMemberRole);

      const updatedMembers = await getTeamMembers();
      setTeamMembers(updatedMembers);
      setNewMemberEmail("");
      setNewMemberRole("member");

      toast({
        title: "Success",
        description: `Added ${newMemberEmail} as ${newMemberRole}`,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to add member";
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setAddingMember(false);
    }
  };

  // Handle removing team member
  const handleRemoveMember = async (memberId: string) => {
    try {
      await removeTeamMember(memberId);
      const updatedMembers = await getTeamMembers();
      setTeamMembers(updatedMembers);
      setDeleteConfirm(null);

      toast({
        title: "Success",
        description: "Team member removed",
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to remove member";
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  // Handle updating member role
  const handleUpdateRole = async (
    memberId: string,
    newRole: "admin" | "member",
  ) => {
    try {
      await updateTeamMemberRole(memberId, newRole);
      const updatedMembers = await getTeamMembers();
      setTeamMembers(updatedMembers);

      toast({
        title: "Success",
        description: "Role updated successfully",
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to update role";
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  // Handle deleting user from Supabase Auth (and all their data)
  const handleDeleteFromAuth = async (email: string) => {
    try {
      setDeletingFromAuth(true);
      await deleteUserAndDataFromAuth({ email });
      setDeleteAuthConfirm(null);
      setDeleteAuthEmail("");

      toast({
        title: "Success",
        description: `User ${email} and all associated data deleted`,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to delete user";
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setDeletingFromAuth(false);
    }
  };

  const uniqueClients = Array.from(
    new Set(articles.map((a) => a.clientName)),
  ).sort();


  // Send to webhook function
  const handleSendToWebhook = async () => {
    try {
      setSendingToWebhook(true);

      const toastId = toast({
        title: "Loading",
        description: "Gathering unedited articles from all users...",
      }).id;

      console.log("[Admin Dashboard] Starting to gather unedited articles...");

      // Get all unedited articles per user
      const uneditedData = await getAllUserUneditedArticles();

      console.log(
        "[Admin Dashboard] Gathered data:",
        uneditedData.length,
        "users",
        uneditedData
      );

      if (uneditedData.length === 0) {
        toast({
          title: "No data",
          description: "No users found. Check your team members setup.",
          variant: "destructive",
        });
        return;
      }

      const totalUneditedCount = uneditedData.reduce(
        (sum, user) => sum + user.count,
        0
      );

      console.log("[Admin Dashboard] Total unedited count:", totalUneditedCount);

      toast({
        title: "Sending",
        description: `Sending ${uneditedData.length} users with ${totalUneditedCount} unedited articles...`,
      });

      // Send to webhook
      const result = await sendToWebhook(uneditedData);

      console.log("[Admin Dashboard] Webhook result:", result);

      if (result.success) {
        toast({
          title: "Success",
          description: `Sent ${uneditedData.length} users with ${totalUneditedCount} unedited articles to webhook`,
        });
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to send to webhook",
          variant: "destructive",
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to send to webhook";
      console.error("[Admin Dashboard] Error sending to webhook:", error);
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setSendingToWebhook(false);
    }
  };

  // Show loading state while checking authorization
  if (isAuthorized === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-border border-t-primary mx-auto"></div>
          <p className="text-sm text-muted-foreground">
            Checking authorization...
          </p>
        </div>
      </div>
    );
  }

  // Show unauthorized message if not admin
  if (isAuthorized === false) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="max-w-md rounded-lg border border-border bg-card p-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="rounded-full bg-destructive/10 p-3">
              <Lock className="h-8 w-8 text-destructive" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-2">
            Access Denied
          </h1>
          <p className="text-sm text-muted-foreground mb-6">
            You don't have permission to access the Admin Dashboard. Only
            administrators can view this page.
          </p>
          <Button onClick={() => navigate("/")} className="gap-2">
            Go to Home
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-lg shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(-1)}
              className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
              title="Go back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-foreground">
                Admin Dashboard
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Manage articles and team members
              </p>
            </div>
          </div>
        </div>
      </header>

      <BatchActivityBanner onNavigate={() => setActiveTab("batch")} />

      <main className="max-w-7xl mx-auto px-6 py-8">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-4 mb-8">
            <TabsTrigger value="articles" className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Articles
            </TabsTrigger>
            <TabsTrigger value="edited-articles" className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Edited Articles
            </TabsTrigger>
            <TabsTrigger value="batch" className="flex items-center gap-2">
              <Upload className="w-4 h-4" />
              Batch Generate
            </TabsTrigger>
            <TabsTrigger value="team" className="flex items-center gap-2">
              <Users className="w-4 h-4" />
              Team Members
            </TabsTrigger>
          </TabsList>

          <TabsContent value="articles" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Filter Articles</CardTitle>
                <CardDescription>
                  Search and filter all editor articles
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">
                      Keyword
                    </label>
                    <Input
                      placeholder="Filter by keyword..."
                      value={keywordFilter}
                      onChange={(e) => setKeywordFilter(e.target.value)}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">
                      Client
                    </label>
                    <Select
                      value={clientFilter}
                      onChange={(e) => setClientFilter(e.target.value)}
                      placeholder="All clients"
                    >
                      <option value="">All clients</option>
                      {uniqueClients.map((client) => (
                        <option key={client} value={client}>
                          {client}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">
                      Team Member
                    </label>
                    <Select
                      value={memberFilter}
                      onChange={(e) => setMemberFilter(e.target.value)}
                      placeholder="All members"
                    >
                      <option value="">All members</option>
                      {teamMembers.map((member) => (
                        <option key={member.id} value={member.user_id || ""}>
                          {member.email_address}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold">
                  Articles ({filteredArticles.length})
                </h2>
              </div>

              {articlesLoading ? (
                <Card>
                  <CardContent className="py-8">
                    <div className="text-center text-muted-foreground">
                      Loading articles...
                    </div>
                  </CardContent>
                </Card>
              ) : filteredArticles.length === 0 ? (
                <Card>
                  <CardContent className="py-8">
                    <div className="text-center text-muted-foreground">
                      No articles found
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4">
                  {filteredArticles.map((article) => (
                    <Card
                      key={article.id}
                      className="hover:shadow-md transition-shadow cursor-pointer"
                      onClick={() =>
                        navigate("/dev-view", { state: { outline: article } })
                      }
                    >
                      <CardHeader>
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <CardTitle className="text-lg">
                              {article.keyword}
                            </CardTitle>
                            <CardDescription className="mt-2">
                              Client: {article.clientName}
                            </CardDescription>
                          </div>
                          <div className="flex items-center gap-2">
                            {article.version && (
                              <Badge variant="secondary">
                                {article.version}
                              </Badge>
                            )}
                            <Badge variant="outline">
                              {article.sections.length} sections
                            </Badge>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-4 gap-4 text-sm">
                          <div>
                            <span className="text-muted-foreground">
                              Created by:
                            </span>
                            <span className="ml-2 font-medium">
                              {article.userId
                                ? teamMembers.find(
                                    (m) => m.user_id === article.userId,
                                  )?.email_address || "Unknown"
                                : "N/A"}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">
                              Word Count:
                            </span>
                            <span className="ml-2 font-medium">
                              {article["word count"] || "N/A"}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">
                              Flesch Score:
                            </span>
                            <span className="ml-2 font-medium">
                              {article["flesch score"] || "N/A"}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">
                              Created:
                            </span>
                            <span className="ml-2 font-medium">
                              {new Date(article.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="edited-articles" className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle>Edited Articles Feedback</CardTitle>
                    <CardDescription>
                      View feedback from editors on articles they've edited
                    </CardDescription>
                  </div>
                  <Button
                    onClick={() => exportFeedbackToCsv(editingFeedback)}
                    disabled={feedbackLoading || editingFeedback.length === 0}
                    variant="outline"
                    size="sm"
                    className="gap-2 shrink-0"
                  >
                    <Download className="w-4 h-4" />
                    Export CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {feedbackLoading ? (
                  <div className="text-center text-muted-foreground py-8">
                    Loading feedback data...
                  </div>
                ) : editingFeedback.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    No feedback data available yet
                  </div>
                ) : (
                  <div className="w-full overflow-x-auto">
                    <table>
                      <thead>
                        <tr className="border-b border-border bg-gray-50">
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground min-w-[220px] max-w-[280px]">
                            Article Title
                          </th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground whitespace-nowrap min-w-[200px]">
                            User
                          </th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground whitespace-nowrap min-w-[120px]">
                            Feedback Date
                          </th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground whitespace-nowrap min-w-[120px]">
                            Reported Time
                          </th>
                          {/* Tracked Time column hidden 2026-05-07 — keep code, just suppress display.
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground whitespace-nowrap min-w-[120px]">
                            Tracked Time
                          </th>
                          */}
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground whitespace-nowrap min-w-[80px]">
                            Version
                          </th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground whitespace-nowrap min-w-[140px]">
                            Original Article
                          </th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground whitespace-nowrap min-w-[130px]">
                            Final Article
                          </th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-foreground min-w-[360px]">
                            Issues
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {editingFeedback.map((feedback) => {
                          const articleId = feedback.articleId || feedback.articleLink?.match(/\/editor\/([^/?]+)/)?.[1];
                          return (
                          <tr
                            key={feedback.id}
                            className="border-b border-border hover:bg-gray-50 transition-colors align-top"
                          >
                            <td className="px-4 py-3 text-sm text-foreground break-words">
                              {feedback.articleTitle}
                            </td>
                            <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                              {feedback.userEmail}
                            </td>
                            <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                              {feedback.createdAt
                                ? new Date(feedback.createdAt).toLocaleDateString()
                                : "N/A"}
                            </td>
                            <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                              {feedback.timeSpent}
                            </td>
                            {/* Tracked Time cell hidden 2026-05-07 — keep code, just suppress display.
                            <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                              {feedback.trackedTimeSeconds ? (
                                (() => {
                                  const anomaly = trackedTimeAnomaly(
                                    feedback.trackedTimeSeconds,
                                    feedback.timeSpent,
                                  );
                                  const formatted = formatSecondsAsHM(feedback.trackedTimeSeconds);
                                  const precise = `${feedback.trackedTimeSeconds}s`;
                                  return (
                                    <span
                                      className="inline-flex items-center gap-1.5"
                                      title={`Raw: ${precise}`}
                                    >
                                      <span className={anomaly ? "text-amber-700 font-medium" : undefined}>
                                        {formatted}
                                      </span>
                                      {anomaly && (
                                        <AlertTriangle
                                          className="w-4 h-4 text-amber-600"
                                          aria-label={anomaly}
                                        >
                                          <title>{anomaly}</title>
                                        </AlertTriangle>
                                      )}
                                    </span>
                                  );
                                })()
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            */}
                            <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                              {feedback.version || <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="px-4 py-3 text-sm whitespace-nowrap">
                              {articleId ? (
                                <a
                                  href={`/share-article/${articleId}?original=true`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline inline-flex items-center gap-1"
                                >
                                  Original
                                  <ExternalLink className="w-4 h-4" />
                                </a>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm whitespace-nowrap">
                              {articleId ? (
                                <a
                                  href={`/share-article/${articleId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline inline-flex items-center gap-1"
                                >
                                  Final
                                  <ExternalLink className="w-4 h-4" />
                                </a>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-foreground">
                              {(() => {
                                const text = feedback.issues || "";
                                const PREVIEW_CHARS = 220;
                                const isLong = text.length > PREVIEW_CHARS;
                                const isExpanded =
                                  !!feedback.id && expandedFeedback.has(feedback.id);
                                if (!isLong) {
                                  return (
                                    <div className="whitespace-pre-wrap">{text}</div>
                                  );
                                }
                                return (
                                  <div>
                                    <div className="whitespace-pre-wrap">
                                      {isExpanded ? text : text.slice(0, PREVIEW_CHARS) + "…"}
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        feedback.id && toggleFeedbackExpand(feedback.id)
                                      }
                                      className="mt-2 text-xs font-medium text-primary hover:underline"
                                    >
                                      {isExpanded ? "Show less" : "Show more"}
                                    </button>
                                  </div>
                                );
                              })()}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="batch" className="space-y-6">
            <BatchGenerateTab userId={currentUserId} />
          </TabsContent>

          <TabsContent value="team" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Delete User from Authentication</CardTitle>
                <CardDescription>
                  Remove a user from Supabase Auth to allow them to register
                  again
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">
                      Email to Delete
                    </label>
                    <Input
                      placeholder="patrick@example.com"
                      type="email"
                      value={deleteAuthEmail}
                      onChange={(e) => setDeleteAuthEmail(e.target.value)}
                    />
                  </div>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      if (deleteAuthEmail.trim()) {
                        setDeleteAuthConfirm({
                          id: "auth-only",
                          email: deleteAuthEmail,
                        });
                      } else {
                        toast({
                          title: "Error",
                          description: "Please enter an email address",
                          variant: "destructive",
                        });
                      }
                    }}
                    className="flex items-center gap-2"
                  >
                    Delete from Auth
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Add Team Member</CardTitle>
                <CardDescription>
                  Add a new team member and assign a role
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">
                      Email
                    </label>
                    <Input
                      placeholder="user@example.com"
                      type="email"
                      value={newMemberEmail}
                      onChange={(e) => setNewMemberEmail(e.target.value)}
                      disabled={addingMember}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">
                      Role
                    </label>
                    <Select
                      value={newMemberRole}
                      onChange={(e: any) => setNewMemberRole(e.target.value)}
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </Select>
                  </div>
                  <Button
                    onClick={handleAddMember}
                    disabled={addingMember}
                    className="flex items-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    Add Member
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div>
              <h2 className="text-xl font-semibold mb-4">
                Team Members ({teamMembers.length})
              </h2>

              {membersLoading ? (
                <Card>
                  <CardContent className="py-8">
                    <div className="text-center text-muted-foreground">
                      Loading team members...
                    </div>
                  </CardContent>
                </Card>
              ) : teamMembers.length === 0 ? (
                <Card>
                  <CardContent className="py-8">
                    <div className="text-center text-muted-foreground">
                      No team members yet
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4">
                  {teamMembers.map((member) => (
                    <Card key={member.id}>
                      <CardContent className="py-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium">
                              {member.email_address}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Joined{" "}
                              {new Date(member.created_at).toLocaleDateString()}
                            </p>
                          </div>
                          <div className="flex items-center gap-4">
                            <Select
                              value={member.role}
                              onChange={(e: any) =>
                                handleUpdateRole(member.id, e.target.value)
                              }
                              className="w-32"
                            >
                              <option value="admin">Admin</option>
                              <option value="member">Member</option>
                            </Select>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setDeleteAuthConfirm({
                                  id: member.id,
                                  email: member.email_address,
                                })
                              }
                            >
                              Delete from Auth
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => setDeleteConfirm(member.id)}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>

      <AlertDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Team Member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this team member? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => deleteConfirm && handleRemoveMember(deleteConfirm)}
            className="bg-destructive hover:bg-destructive/90"
          >
            Remove
          </AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!deleteAuthConfirm}
        onOpenChange={(open) => !open && setDeleteAuthConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User and All Data</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete {deleteAuthConfirm?.email} from Supabase
              Authentication along with all their associated articles, comments,
              and access records. They will be able to register again with the
              same email. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              deleteAuthConfirm && handleDeleteFromAuth(deleteAuthConfirm.email)
            }
            disabled={deletingFromAuth}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deletingFromAuth ? "Deleting..." : "Delete User and Data"}
          </AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
