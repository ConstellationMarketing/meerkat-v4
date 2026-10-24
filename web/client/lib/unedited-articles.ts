import { supabase } from "@/lib/supabase";
import { getArticleOutlines } from "@/lib/storage";

export interface UneditedArticle {
  article_id: string;
  article_title: string;
  article_link: string;
}

export interface UserUneditedData {
  email: string;
  uneditedArticles: UneditedArticle[];
  count: number;
  timestamp: string;
}

/**
 * Get all unedited articles for a specific user
 * An article is considered "unedited" if no record exists in timer_and_feedbacks
 * for that user and article combination
 */
export async function getUneditedArticlesForUser(
  userEmail: string,
  userId?: string
): Promise<UneditedArticle[]> {
  try {
    // Get all articles accessible to this user
    const allArticles = await getArticleOutlines({
      userId: userId,
      userRole: "member",
    });

    // Get articles that have been edited by this user
    const { data: editedRecords, error: editError } = await supabase
      .from("timer_and_feedbacks")
      .select("article_id")
      .eq("user", userEmail);

    if (editError) {
      console.error("Error fetching edited articles:", editError);
      return [];
    }

    const editedArticleIds = new Set(
      (editedRecords || []).map((record: any) => record.article_id)
    );

    // Filter out edited articles
    const uneditedArticles = allArticles
      .filter((article) => !editedArticleIds.has(article.id))
      .map((article) => ({
        article_id: article.id,
        article_title: article.title || article.keyword || "Untitled",
        article_link: `https://meerkatv3.netlify.app/editor/${article.id}`,
      }));

    return uneditedArticles;
  } catch (error) {
    console.error("Error getting unedited articles for user:", error);
    return [];
  }
}

/**
 * Get unedited articles for all users
 */
export async function getAllUserUneditedArticles(): Promise<UserUneditedData[]> {
  try {
    // Get all team members
    const response = await fetch("/api/team-members");
    if (!response.ok) {
      throw new Error("Failed to fetch team members");
    }
    const teamMembers = await response.json();

    // For each team member, get their unedited articles
    const results: UserUneditedData[] = [];

    for (const member of teamMembers) {
      const uneditedArticles = await getUneditedArticlesForUser(
        member.email_address,
        member.user_id
      );

      results.push({
        email: member.email_address,
        uneditedArticles,
        count: uneditedArticles.length,
        timestamp: new Date().toISOString(),
      });
    }

    return results;
  } catch (error) {
    console.error("Error getting all user unedited articles:", error);
    return [];
  }
}

/**
 * Send unedited articles data to webhook
 */
export async function sendToWebhook(
  data: UserUneditedData[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const webhookUrl =
      "https://n8n-14lp.onrender.com/webhook/decb968b-7b9c-4046-a18e-933c6879fb8c";

    const payload = {
      data,
      sentAt: new Date().toISOString(),
      userCount: data.length,
      totalUneditedArticles: data.reduce((sum, user) => sum + user.count, 0),
      source: "meerkat-editor",
    };

    console.log("[unedited-articles] Sending payload to webhook:", payload);

    // Call the webhook directly (works in dev and production)
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log(
      "[unedited-articles] Webhook response status:",
      response.status
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[unedited-articles] Webhook error:",
        response.status,
        errorText
      );
      return {
        success: false,
        error: `Webhook returned ${response.status}`,
      };
    }

    const responseText = await response.text();
    console.log("[unedited-articles] Webhook response:", responseText);

    return { success: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("[unedited-articles] Error sending to webhook:", errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}
