import { createVIGitHubOAuthState } from "@vi/core";
import { type NextRequest, NextResponse } from "next/server";
import {
  buildGitHubOAuthAuthorizeUrl,
  buildGitHubOAuthPopupHtml,
  buildOAuthReturnUrl,
  getRequestOrigin,
} from "@/lib/github-oauth";
import { getServices } from "@/lib/services";
import { validateConfiguredProject } from "@/lib/validation";

export async function GET(request: NextRequest) {
  const { config } = await getServices();
  const requestOrigin = getRequestOrigin(request);
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project")?.trim();
  const popup = url.searchParams.get("popup") === "1";

  const popupErrorResponse = (error: string) =>
    new NextResponse(
      buildGitHubOAuthPopupHtml({
        requestOrigin,
        projectId: projectId ?? undefined,
        success: false,
        error,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );

  if (!projectId) {
    if (popup) return popupErrorResponse("project_required");
    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, "/", { github_error: "project_required" }),
    );
  }

  const configuredProjectErr = validateConfiguredProject(config.projects, projectId);
  if (configuredProjectErr) {
    if (popup) return popupErrorResponse("unknown_project");
    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, "/", { project: projectId, github_error: "unknown_project" }),
    );
  }

  try {
    const returnTo =
      url.searchParams.get("returnTo")?.trim() || `/?project=${encodeURIComponent(projectId)}`;
    const state = await createVIGitHubOAuthState(config.configPath, {
      projectId,
      returnTo,
      popup,
    });
    return NextResponse.redirect(
      buildGitHubOAuthAuthorizeUrl({
        requestOrigin,
        state,
      }),
    );
  } catch (error) {
    if (popup) {
      return popupErrorResponse(error instanceof Error ? error.message : "oauth_start_failed");
    }
    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, `/?project=${encodeURIComponent(projectId)}`, {
        github_error: error instanceof Error ? error.message : "oauth_start_failed",
      }),
    );
  }
}
