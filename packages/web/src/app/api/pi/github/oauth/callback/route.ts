import {
  consumePIGitHubOAuthState,
  listPIGitHubConnectors,
  upsertPIGitHubConnector,
} from "@pi/core";
import { type NextRequest, NextResponse } from "next/server";
import {
  buildGitHubOAuthPopupHtml,
  buildOAuthReturnUrl,
  exchangeGitHubOAuthCode,
  fetchGitHubViewer,
  getRequestOrigin,
} from "@/lib/github-oauth";
import { getServices } from "@/lib/services";

export async function GET(request: NextRequest) {
  const { config } = await getServices();
  const requestOrigin = getRequestOrigin(request);
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  const oauthError = url.searchParams.get("error")?.trim();

  const popupResponse = (input: {
    projectId?: string;
    success?: boolean;
    login?: string;
    error?: string;
  }) =>
    new NextResponse(
      buildGitHubOAuthPopupHtml({
        requestOrigin,
        ...input,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );

  if (oauthError) {
    if (state) {
      const consumed = await consumePIGitHubOAuthState(config.configPath, state);
      if (consumed?.popup) {
        return popupResponse({
          projectId: consumed.projectId,
          success: false,
          error: oauthError,
        });
      }
      if (consumed) {
        return NextResponse.redirect(
          buildOAuthReturnUrl(requestOrigin, consumed.returnTo, {
            project: consumed.projectId,
            github_error: oauthError,
          }),
        );
      }
    }
    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, "/", {
        github_error: oauthError,
      }),
    );
  }

  if (!state || !code) {
    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, "/", {
        github_error: "missing_oauth_parameters",
      }),
    );
  }

  const consumed = await consumePIGitHubOAuthState(config.configPath, state);
  if (!consumed) {
    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, "/", {
        github_error: "invalid_or_expired_state",
      }),
    );
  }

  const project = config.projects[consumed.projectId];
  if (!project) {
    if (consumed.popup) {
      return popupResponse({
        projectId: consumed.projectId,
        success: false,
        error: "unknown_project",
      });
    }
    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, consumed.returnTo, {
        github_error: "unknown_project",
      }),
    );
  }

  try {
    const token = await exchangeGitHubOAuthCode({
      requestOrigin,
      code,
    });
    const viewer = await fetchGitHubViewer(token.accessToken);
    const currentStore = await listPIGitHubConnectors(config.configPath, project.path);
    const reusable =
      currentStore.connectors.find(
        (connector) =>
          connector.authType === "oauth" &&
          connector.accountLogin.toLowerCase() === viewer.login.toLowerCase(),
      ) ??
      (currentStore.selectedConnectorId
        ? currentStore.connectors.find((connector) => connector.id === currentStore.selectedConnectorId)
        : undefined);

    await upsertPIGitHubConnector(config.configPath, project.path, {
      id: reusable?.id,
      label: reusable?.label ?? `${project.name ?? consumed.projectId} GitHub`,
      host: reusable?.host ?? "github.com",
      accountLogin: viewer.login,
      owner: reusable?.owner ?? viewer.login,
      repo: reusable?.repo ?? "",
      accessToken: token.accessToken,
      authType: "oauth",
      setAsSelected: true,
    });

    if (consumed.popup) {
      return popupResponse({
        projectId: consumed.projectId,
        success: true,
        login: viewer.login,
      });
    }

    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, consumed.returnTo, {
        project: consumed.projectId,
        github_connected: viewer.login,
      }),
    );
  } catch (error) {
    if (consumed.popup) {
      return popupResponse({
        projectId: consumed.projectId,
        success: false,
        error: error instanceof Error ? error.message : "oauth_callback_failed",
      });
    }
    return NextResponse.redirect(
      buildOAuthReturnUrl(requestOrigin, consumed.returnTo, {
        project: consumed.projectId,
        github_error: error instanceof Error ? error.message : "oauth_callback_failed",
      }),
    );
  }
}
