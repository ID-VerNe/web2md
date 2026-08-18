/// <reference types="wxt-vite-plugin" />

/** web2md — 任务结果回写。 */

export async function reportResult(
  fastapiHost: string,
  port: number,
  taskId: string,
  markdown: string | null,
  status = "done",
  tabUrl?: string
): Promise<void> {
  try {
    const resp = await fetch(
      `${fastapiHost}:${port}/api/tasks/${taskId}/result`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: markdown ?? "",
          status: markdown ? status : "failed",
          url: tabUrl,
        }),
      }
    );
    const text = await resp.text();
    console.log("[web2md-diag] reportResult", {
      taskId,
      status,
      markdownLen: (markdown ?? "").length,
      httpStatus: resp.status,
      body: text,
    });
  } catch (err) {
    console.error("web2md: report result failed", err);
  }
}