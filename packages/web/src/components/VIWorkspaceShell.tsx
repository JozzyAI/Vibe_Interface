import type { ReactNode } from "react";
import Link from "next/link";
import type { ProjectInfo } from "@/lib/project-name";
import { ModeIndicator } from "@/components/ModeIndicator";

type ActiveArea = "home" | "sessions" | "tasks" | "agents" | "drafts" | "approvals";

interface Props {
  active: ActiveArea;
  title: string;
  subtitle: string;
  projectName?: string;
  projects: ProjectInfo[];
  connectedCount: number;
  workspaceRoot: string;
  workspaceFiles: string[];
  sidebarContent?: ReactNode;
  sidebarFooter?: ReactNode;
  rightSidebarContent?: ReactNode;
  rightSidebarTitle?: string;
  hideHeader?: boolean;
  children: ReactNode;
}

function navClass(active: boolean): string {
  return [
    "flex h-11 items-center gap-3 rounded-xl px-4 text-[14px] font-semibold hover:no-underline",
    active ? "bg-[#eef0f1] text-[#1e2026]" : "text-[#626873] hover:bg-[#f6f6f5]",
  ].join(" ");
}

function fileGlyph(name: string): string {
  return name.includes(".") ? "|" : ">";
}

function RailIcon({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      title={label}
      className="grid w-[64px] justify-items-center gap-1 rounded-2xl px-1 py-2 text-center text-[10px] font-semibold text-[#5f4fb8] hover:bg-[#f4f5f5] hover:no-underline"
    >
      <span
        className={[
          "grid h-10 w-10 place-items-center rounded-xl border text-[15px] shadow-sm",
          active
            ? "border-[#9ed9e5] bg-[#0b8ea6] text-white"
            : "border-[#e4e4e0] bg-white text-[#5f4fb8]",
        ].join(" ")}
      >
        {children}
      </span>
      <span>{label}</span>
    </Link>
  );
}

export function VIWorkspaceShell({
  active,
  title,
  subtitle,
  projectName,
  projects,
  connectedCount,
  workspaceRoot,
  workspaceFiles,
  sidebarContent,
  sidebarFooter,
  rightSidebarContent,
  rightSidebarTitle,
  hideHeader,
  children,
}: Props) {
  return (
    <div className="flex h-screen overflow-hidden bg-[#fbfbfa] text-[#1e2026]">
      <aside className="flex w-[70px] shrink-0 flex-col items-center border-r border-[#ececea] bg-white py-2">
        <Link
          href="/"
          className="mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-[#9ed9e5] bg-[#0b8ea6] text-[13px] font-bold text-white shadow-sm hover:no-underline"
        >
          PI
        </Link>
        <nav className="flex flex-1 flex-col items-center gap-3">
          <RailIcon href="/" label="Home" active={active === "home"}>+</RailIcon>
          <RailIcon href="/sessions" label="Sessions" active={active === "sessions" || active === "tasks" || active === "approvals"}>=</RailIcon>
          <RailIcon href="/agents" label="Machines" active={active === "agents"}>@</RailIcon>
          {/* <RailIcon href="/ideas" label="Drafts" active={active === "drafts"}>#</RailIcon> */}
        </nav>
        {process.env.VI_ACCESS_TOKEN ? (
          <a
            href="/api/auth/logout"
            title="Sign out"
            className="mb-1 grid h-9 w-9 place-items-center rounded-xl text-[#c0c5cd] hover:bg-[#f4f5f5] hover:text-[#30333a]"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3" />
              <path d="M10.5 11L14 8l-3.5-3" />
              <path d="M14 8H6" />
            </svg>
          </a>
        ) : null}
      </aside>

      <aside className="flex w-[352px] shrink-0 flex-col border-r border-[#ececea] bg-white">
        <div className="flex h-16 items-center gap-3 border-b border-[#ececea] px-4">
          <Link href="/" className="text-[22px] text-[#7b808a] hover:no-underline">
            &lt;
          </Link>
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#0b8ea6] text-[11px] font-bold text-white">
            PI
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{projectName ?? "Vibe Interface"}</p>
            <p className="text-[11px] text-[#8b9099]">{connectedCount} machine online</p>
          </div>
        </div>

        <div className="hidden">
          <Link href="/" className={navClass(active === "home")}>
            <span className="text-[18px]">+</span>
            Home
          </Link>
          <Link href="/tasks" className={navClass(active === "tasks")}>
            <span className="text-[14px]">TK</span>
            Tasks
          </Link>
          <Link href="/agents" className={navClass(active === "agents")}>
            <span className="text-[14px]">●</span>
            Machines
          </Link>
          <Link href="/ideas" className={navClass(active === "drafts")}>
            <span className="text-[14px]">◆</span>
            Drafts
          </Link>
          <Link href="/approval-hub" className={navClass(active === "approvals")}>
            <span className="text-[14px]">!</span>
            Approvals
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {sidebarContent ?? (
            <>
              <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.16em] text-[#a1a5ad]">
                Projects
              </p>
              <div className="space-y-1">
                {projects.map((project) => (
                  <a
                    key={project.id}
                    href={`/?project=${encodeURIComponent(project.id)}`}
                    className="block truncate rounded-xl px-3 py-2 text-[14px] font-medium text-[#30333a] hover:bg-[#f4f5f5] hover:no-underline"
                  >
                    {project.name}
                  </a>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="border-t border-[#ececea]">
          <div className="flex h-10 items-center px-5 text-[12px] text-[#9aa1ad]">
            {sidebarFooter ?? `${connectedCount} machine${connectedCount === 1 ? "" : "s"} online`}
          </div>
          <ModeIndicator />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto bg-[#fcfcfb]">
        <div className="mx-auto max-w-[1180px] px-8 py-8">
          {!hideHeader ? (
            <header className="mb-6">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#9aa1ad]">
                {active === "home"
                  ? "Home"
                  : active === "sessions" || active === "tasks" || active === "approvals"
                    ? "Sessions"
                    : active === "agents"
                      ? "Machines"
                      : active === "drafts"
                        ? "Drafts"
                        : "Approvals"}
              </p>
              <h1 className="mt-2 text-[34px] font-semibold tracking-[-0.04em]">{title}</h1>
              <p className="mt-2 max-w-2xl text-[14px] leading-7 text-[#626873]">{subtitle}</p>
            </header>
          ) : null}
          {children}
        </div>
      </main>

      <aside className="hidden w-[360px] shrink-0 border-l border-[#ececea] bg-white xl:flex xl:flex-col">
        <div className="flex h-14 items-center justify-between border-b border-[#ececea] px-5">
          <p className="text-[14px] font-semibold uppercase tracking-[0.08em] text-[#9aa1ad]">
            {rightSidebarTitle ?? "Context"}
          </p>
          {!rightSidebarContent ? <span className="text-[#9aa1ad]">refresh</span> : null}
        </div>
        {rightSidebarContent ?? (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 flex items-center gap-2 text-[14px] font-semibold">
                <span className="h-5 w-1.5 rounded bg-[#7d8794]" />
                {workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace"}
              </div>
              <div className="space-y-2 text-[14px]">
                {workspaceFiles.map((name) => (
                  <div key={name} className="flex items-center gap-2 text-[#444852]">
                    <span className="w-4 text-[#7d8794]">{fileGlyph(name)}</span>
                    <span className="truncate">{name}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t border-[#ececea] p-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#a1a5ad]">
                Context
              </p>
              <div className="mt-3 space-y-2 text-[13px] text-[#737882]">
                <p className="truncate">root: {workspaceRoot}</p>
                <p>PI keeps agents, ideas, and approvals in this same workspace.</p>
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
