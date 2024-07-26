import { Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import * as fs from "fs/promises";

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "write-file",
			name: "Export to local hugo repo",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const basePath =
					"/Users/jonbo/Github/jborichevskiy/up-and-to-the-right/content/posts/";

				const file = view?.file;
				if (!file) return;

				const actualPath = file.path;
				const parts = actualPath.split("/");
				const filename = parts[parts.length - 1];

				// Check if it's a daily note
				const date = filename.split(".")[0];
				if (date.match(/^\d{4}-\d{2}-\d{2}$/)) {
					console.log("daily file detected, skipping");
					return;
				}

				// Get file content
				let content = editor.getDoc().getValue();

				const frontmatter = this.getFrontmatter(content);
				if (
					!frontmatter ||
					!frontmatter.tags ||
					!frontmatter.tags.includes("#publish")
				) {
					console.log(
						"no #publish tag in frontmatter detected, skipping"
					);
					return;
				}

				// Check if frontmatter exists and has a date
				if (!frontmatter || !frontmatter.date) {
					// If no date, add current date in yyyy-mm-dd format
					const currentDate = new Date().toISOString().split("T")[0];
					content = content.replace(
						/^---\n/,
						`---\ndate: ${currentDate}\n`
					);
				}

				// Convert filename to title
				const title = this.filenameToTitle(filename);

				// Check if frontmatter exists and has a title
				if (!frontmatter || !frontmatter.title) {
					// If no title, add the converted filename as title
					content = content.replace(
						/^---\n/,
						`---\ntitle: ${title}\n`
					);
				}

				// Handle images
				const imageRegex = /!\[\[(.*?)\]\]/g;
				const matches = content.matchAll(imageRegex);

				for (const match of matches) {
					const imageName = match[1];
					const sourceFile =
						this.app.vault.getAbstractFileByPath(imageName);
					if (sourceFile instanceof TFile) {
						const sourcePath = this.app.vault.adapter.getFullPath(
							sourceFile.path
						);
						const destPath = `/Users/jonbo/Github/jborichevskiy/up-and-to-the-right/static/${imageName}`;

						try {
							await fs.copyFile(sourcePath, destPath);
							console.log(`Copied image: ${imageName}`);

							content = content.replace(
								match[0],
								`{{<figure src="/${imageName}" caption="">}}\n`
							);
						} catch (error) {
							console.error(
								`Error copying image ${imageName}:`,
								error
							);
						}
					} else {
						console.error(`Image not found in vault: ${imageName}`);
					}
				}

				//todo: figure out whether to put this in /posts or / at the root

				const path =
					basePath + filename.replace(/\s+/g, "-").toLowerCase();

				try {
					await fs.writeFile(path, content);
					new Notice("File and images exported successfully.");
				} catch (error) {
					console.error("Error writing file:", error);
					new Notice(
						"Failed to write file. Check console for details."
					);
				}
			},
		});

		this.addCommand({
			id: "publish-post",
			name: "publish to notes.site",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				console.log("command:publish");

				const file = view?.file;
				if (!file) return;

				const path = file.path;
				const parts = path.split("/");
				const filename = parts[parts.length - 1];

				// Check if it's a daily note
				const date = filename.split(".")[0];
				if (date.match(/^\d{4}-\d{2}-\d{2}$/)) {
					console.log("daily file detected, skipping");
					return;
				}

				// Get file content
				const content = editor.getDoc().getValue();

				const frontmatter = this.getFrontmatter(content);
				if (
					!frontmatter ||
					!frontmatter.tags ||
					!frontmatter.tags.includes("#publish")
				) {
					console.log(
						"no #publish tag in frontmatter detected, skipping"
					);
					return;
				}

				// Convert filename to title
				const title = this.filenameToTitle(filename);

				const response = await fetch(
					"https://jonbo-notessiteingest.web.val.run",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							id: Date.now(),
							title: title,
							content: btoa(encodeURIComponent(content)),
						}),
					}
				);
				console.log({ response });
			},
		});
	}

	filenameToTitle(filename: string): string {
		// Remove file extension
		let title = filename.replace(/\.md$/, "");

		// Replace hyphens and underscores with spaces
		title = title.replace(/[-_]/g, " ");

		return title;
	}

	getFrontmatter(content: string): any {
		const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);

		if (match && match[1]) {
			const frontmatter = {};
			const lines = match[1].split("\n");
			let currentKey = "";

			for (const line of lines) {
				if (line.trim() === "") continue;

				if (line.startsWith("  - ")) {
					// Handle list items
					if (!Array.isArray(frontmatter[currentKey])) {
						frontmatter[currentKey] = [];
					}
					frontmatter[currentKey].push(
						line
							.substr(4)
							.trim()
							.replace(/^"(.*)"$/, "$1")
					);
				} else if (line.includes(":")) {
					// Handle key-value pairs
					const [key, ...valueParts] = line.split(":");
					currentKey = key.trim();
					const value = valueParts
						.join(":")
						.trim()
						.replace(/^"(.*)"$/, "$1");
					frontmatter[currentKey] = value || [];
				}
			}
			return frontmatter;
		}

		return null;
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
