import type { BonoboClient } from "bonobo-plugin-sdk/frontend";
import { describe, expect, test, vi } from "vitest";
import { register_mail_tools, type MailView } from "./agent-tools";

function make_page() {
	const handlers = new Map<string, (input: unknown) => unknown>();
	const mutation = vi.fn(async () => ({ _yay: { key: "k", revision: 1, byteSize: 10 } }));
	const client = {
		context: { kind: "page", userId: "user1" },
		agent: {
			registerTool: (name: string, handler: (input: unknown) => unknown) => {
				handlers.set(name, handler);
				return () => handlers.delete(name);
			},
		},
		convex: { mutation },
		api: { plugins_data: { user_put_owned_document: "put", user_remove_owned_document: "remove" } },
	} as unknown as BonoboClient;
	const view: MailView = { accountPath: null, folder: "all", rows: [], openEmail: null, openDraftId: null, drafts: [] };
	const showDraft = vi.fn();
	const unregister = register_mail_tools(client, { getView: () => view, showEmail: vi.fn(), showDraft });

	return { handlers, mutation, showDraft, unregister };
}

describe("register_mail_tools", () => {
	test("create_draft saves an agent draft under the member's key and opens it", async () => {
		const page = make_page();

		const output = (await page.handlers.get("create_draft")!({
			to: ["ada@example.com"],
			subject: "Re: Lunch",
			body: "Friday works.",
		})) as { draftId: string };

		expect(page.mutation).toHaveBeenCalledWith("put", {
			collection: "drafts",
			key: `user1-${output.draftId}`,
			value: {
				id: output.draftId,
				to: ["ada@example.com"],
				cc: [],
				subject: "Re: Lunch",
				body: "Friday works.",
				replyToPath: null,
				agentEditedAt: expect.any(Number),
			},
		});
		expect(page.showDraft).toHaveBeenCalledWith(output.draftId);
	});

	test("create_draft refuses bad input before it writes", async () => {
		const page = make_page();

		await expect(
			Promise.resolve().then(() => page.handlers.get("create_draft")!({ to: "ada@example.com", subject: "x", body: "y" })),
		).rejects.toThrow("to must be a list of strings");
		// 6,000 three-byte characters are 18 KB, more than the store keeps in one document.
		await expect(
			Promise.resolve().then(() => page.handlers.get("create_draft")!({ to: [], subject: "x", body: "語".repeat(6000) })),
		).rejects.toThrow("at most 15 KB");
		expect(page.mutation).not.toHaveBeenCalled();
	});

	test("the returned function removes every tool", () => {
		const page = make_page();

		page.unregister();

		expect(page.handlers.size).toBe(0);
	});
});
