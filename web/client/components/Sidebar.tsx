import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  Folder,
  X,
  Settings,
  LogOut,
  Menu,
  ChevronLeft,
  Shield,
  HelpCircle,
} from "lucide-react";
import { ArticleOutline } from "@/types/article";
import {
  getClientFolders,
  ClientFolder,
  CLIENT_FOLDERS_UPDATED_EVENT,
} from "@/lib/client-folders";
import { getArticleOutlines, deleteArticleOutline } from "@/lib/storage";
import { signOut, getCurrentUser } from "@/lib/auth";
import { getUserRole } from "@/lib/team-members";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getAppVersion } from "@/lib/version";
import { SupportForm } from "@/components/SupportForm";

interface SidebarProps {
  onSelectProject: (id: string | null) => void;
  onSelectClient: (clientName: string, clientId?: string) => void;
  onCreateNew: () => void;
  onSettings: () => void;
  onAdmin?: () => void;
  onLogout?: () => void;
  selectedProjectId: string | null;
  selectedClientName: string | null;
  refreshKey?: number;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  userRole?: "admin" | "member" | null;
  userId?: string;
}

export function Sidebar({
  onSelectProject,
  onSelectClient,
  onCreateNew,
  onSettings,
  onAdmin,
  onLogout,
  selectedProjectId,
  selectedClientName,
  refreshKey = 0,
  isCollapsed = false,
  onToggleCollapse,
  userRole = null,
  userId,
}: SidebarProps) {
  const { toast } = useToast();
  const [outlines, setOutlines] = useState<ArticleOutline[]>([]);
  const [clientFolders, setClientFolders] = useState<ClientFolder[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [appVersion] = useState(getAppVersion());
  const [isSupportFormOpen, setIsSupportFormOpen] = useState(false);
  const [userEmail, setUserEmail] = useState("");

  const handleLogout = async () => {
    try {
      await signOut();
      toast({
        title: "Signed out",
        description: "You have been signed out successfully.",
      });
      if (onLogout) {
        onLogout();
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Logout failed";
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    const fetchUserEmail = async () => {
      const user = await getCurrentUser();
      if (user) {
        setUserEmail(user.email);
      }
    };
    fetchUserEmail();
  }, []);

  useEffect(() => {
    const fetchOutlines = async () => {
      console.log(
        "🔍 Sidebar fetching articles with userId:",
        userId,
        "userRole:",
        userRole,
      );
      const data = await getArticleOutlines({
        userId,
        userRole: userRole as "admin" | "member" | undefined,
      });
      console.log("📄 Sidebar received articles:", data.length, "articles");
      data.forEach((a) => {
        console.log(`  - ${a.keyword} (userId: ${a.userId || "NULL"})`);
      });
      setOutlines(data);
    };
    fetchOutlines();
  }, [refreshKey, userId, userRole]);

  // Fetch client folders on mount and whenever refreshKey changes
  const loadClientFolders = useCallback(async () => {
    const folders = await getClientFolders();
    setClientFolders(folders);
  }, []);

  useEffect(() => {
    loadClientFolders();
  }, [refreshKey, loadClientFolders]);

  useEffect(() => {
    const handleUpdate = () => {
      loadClientFolders();
    };

    window.addEventListener(CLIENT_FOLDERS_UPDATED_EVENT, handleUpdate);
    return () => {
      window.removeEventListener(CLIENT_FOLDERS_UPDATED_EVENT, handleUpdate);
    };
  }, [loadClientFolders]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this project?")) {
      await deleteArticleOutline(id);
      const data = await getArticleOutlines({
        userId,
        userRole: userRole as "admin" | "member" | undefined,
      });
      setOutlines(data);
      if (selectedProjectId === id) {
        onSelectProject(null);
      }
    }
  };

  const filteredClients = clientFolders
    .filter((folder) =>
      folder.name.toLowerCase().includes(searchTerm.toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const outlinesByClientKey = new Map<string, ArticleOutline[]>();
  if (Array.isArray(outlines)) {
    outlines.forEach((outline) => {
      const key = outline.clientId || outline.clientName;
      if (!key) return;
      if (!outlinesByClientKey.has(key)) {
        outlinesByClientKey.set(key, []);
      }
      outlinesByClientKey.get(key)!.push(outline);
    });
  }

  if (isCollapsed) {
    return (
      <div className="w-16 border-r border-border bg-card flex flex-col h-full items-center py-4 gap-4">
        <Button
          onClick={onToggleCollapse}
          variant="ghost"
          size="sm"
          className="p-2 h-8 w-8"
          title="Expand sidebar"
        >
          <Menu className="h-4 w-4" />
        </Button>

        <Button
          onClick={onCreateNew}
          variant="ghost"
          size="sm"
          className="p-2 h-8 w-8"
          title="New Article"
        >
          <Plus className="h-4 w-4" />
        </Button>

        <div className="flex flex-col items-center gap-4 mt-auto w-full">
          {onAdmin && userRole === "admin" && (
            <Button
              onClick={onAdmin}
              variant="ghost"
              size="sm"
              className="p-2 h-8 w-8"
              title="Admin Dashboard"
            >
              <Shield className="h-4 w-4" />
            </Button>
          )}
          <Button
            onClick={onSettings}
            variant="ghost"
            size="sm"
            className="p-2 h-8 w-8"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>

          <Button
            onClick={handleLogout}
            variant="ghost"
            size="sm"
            className="p-2 h-8 w-8 text-red-600 hover:text-red-700"
            title="Sign Out"
          >
            <LogOut className="h-4 w-4" />
          </Button>

          <div className="text-xs text-muted-foreground text-center break-words w-full px-1">
            v{appVersion}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-80 border-r border-border bg-blue-600 flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <img
            src="https://cdn.builder.io/api/v1/image/assets%2Fc8a7b33c1f3e4309983e45cabed92535%2F0880a05f78214d64a4c779268ac28dc4?format=webp&width=800"
            alt="Meerkat"
            className="h-12"
          />
          <Button
            onClick={onToggleCollapse}
            variant="ghost"
            size="sm"
            className="p-1 h-6 w-6"
            title="Collapse sidebar"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
        <Button
          onClick={onCreateNew}
          className="w-full gap-2 bg-primary hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Article
        </Button>
      </div>

      {/* Search */}
      <div className="border-b border-border px-4 py-4">
        <div className="relative flex items-center gap-2">
          <Input
            type="text"
            placeholder="Search clients..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm("")}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Client Folders */}
      <div className="flex-1 overflow-y-auto">
        {filteredClients.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-sm text-muted-foreground">No clients found</p>
          </div>
        ) : (
          <div className="p-2 space-y-2">
            {filteredClients.map((folder) => {
              const clientKey = folder.client_id || folder.name;
              const clientOutlines = outlinesByClientKey.get(clientKey) || [];
              const hasProjects = clientOutlines.length > 0;

              return (
                <div key={folder.id} className="space-y-1">
                  <button
                    onClick={() =>
                      onSelectClient(folder.name, folder.client_id)
                    }
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-accent/50 transition-colors text-left ${
                      selectedClientName === folder.name
                        ? "text-primary bg-primary/10"
                        : "text-foreground"
                    }`}
                    title="View all articles"
                  >
                    <Folder className="h-4 w-4 text-primary/70 flex-shrink-0" />
                    <span className="text-sm font-medium truncate flex-1">
                      {folder.name}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {clientOutlines.length}
                    </span>
                  </button>

                  {/* Articles are now only accessible via the ClientArticles page */}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Settings and Logout Buttons */}
      <div className="border-t border-border p-4 space-y-2">
        {onAdmin && userRole === "admin" && (
          <Button onClick={onAdmin} variant="outline" className="w-full gap-2">
            <Shield className="h-4 w-4" />
            Admin Dashboard
          </Button>
        )}
        <Button onClick={onSettings} variant="outline" className="w-full gap-2">
          <Settings className="h-4 w-4" />
          Settings
        </Button>
        <Button
          onClick={() => setIsSupportFormOpen(true)}
          variant="outline"
          className="w-full gap-2"
        >
          <HelpCircle className="h-4 w-4" />
          Support
        </Button>
        <Button
          onClick={handleLogout}
          variant="outline"
          className="w-full gap-2 text-red-600 hover:text-red-700 hover:bg-red-50"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </Button>

        {/* Version Display */}
        <div className="pt-2 border-t border-border/50 text-center text-xs text-muted-foreground">
          <p>v{appVersion}</p>
        </div>
      </div>

      {/* Support Form Modal */}
      <SupportForm
        isOpen={isSupportFormOpen}
        onOpenChange={setIsSupportFormOpen}
        userEmail={userEmail}
      />
    </div>
  );
}
