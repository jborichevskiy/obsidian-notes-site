import { Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import * as fs from "fs/promises";
import { App, PluginSettingTab, Setting } from "obsidian";
import markdownit from "markdown-it";
import { Token } from "markdown-it";

interface MyPluginSettings {
	mySetting: string;
	startPageExportPath: string;
}

interface Frontmatter {
	[key: string]: string | string[] | undefined;
	tags?: string[];
	date?: string;
	title?: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	startPageExportPath: "",
};

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// Register the mobile toolbar button when layout changes
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.addMobileScrollButton();
			})
		);

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
						const sourcePath =
							this.app.vault.getResourcePath(sourceFile);
						const destPath = `/Users/jonbo/Github/jborichevskiy/up-and-to-the-right/static/${imageName}`;

						const exists = await this.fileExistsWithSameSize(
							sourcePath,
							destPath
						);

						try {
							if (!exists) {
								await fs.copyFile(sourcePath, destPath);
								console.log(`Copied image: ${imageName}`);
							}

							const assembledFigure = `{{<figure src="/${imageName}" caption="">}}\n`;
							content = content.replace(
								match[0],
								assembledFigure
							);
							console.log({ assembledFigure });
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

				// Remove lines starting with 'tags:' or two spaces
				console.log(content);
				content = content
					.split("\n")
					.filter(
						(line) =>
							!line.startsWith("tags:") && !line.startsWith("  ")
					)
					.join("\n");

				// Replace hugoAliases with aliases if it exists
				if (frontmatter && frontmatter.hugoAliases) {
					console.log("replacing!");
					content = content.replace(/hugoAliases:/, "aliases:");
				}
				// Remove single quotes from the 'aliases:' line if it exists
				content = content.replace(/^(aliases:.*)'(.*)'/gm, "$1$2");

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

		// Add the new START page export command
		this.addCommand({
			id: "export-start-page",
			name: "Export START page to HTML",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const file = view?.file;
				if (!file) return;

				// Only proceed if the file is named START
				if (file.basename !== "START") {
					new Notice("This command only works on the START page");
					return;
				}

				// Check if export path is configured
				if (!this.settings.startPageExportPath) {
					new Notice(
						"Please configure the START page export path in settings"
					);
					return;
				}

				// Get file content
				const content = editor.getDoc().getValue();

				// Convert Obsidian internal links to markdown links with obsidian:// URLs
				const processedContent = content.replace(
					/\[\[(.*?)\]\]/g,
					(match, linkText) => {
						const encodedPath = encodeURIComponent(linkText);
						return `[${linkText}](obsidian://open?vault=jonbo-notes-site-sync&file=${encodedPath})`;
					}
				);

				// Initialize markdown-it with options
				const md = markdownit({
					html: true,
					breaks: true,
					linkify: true,
				});

				// Custom renderer for internal links
				md.renderer.rules.link_open = (
					tokens: Token[],
					idx: number,
					options: markdownit.Options,
					env: any,
					self: any
				) => {
					const token = tokens[idx];
					const hrefIndex = token.attrIndex("href");
					if (hrefIndex >= 0) {
						const href = token.attrs![hrefIndex][1];
						if (
							href &&
							href.startsWith("[[") &&
							href.endsWith("]]")
						) {
							// Extract the link text
							const linkText = href.slice(2, -2);
							// Create obsidian URI
							const obsidianUri = `obsidian://open?vault=jonbo-notes-site-sync&file=${encodeURIComponent(
								linkText
							)}`;
							// Set the href attribute
							token.attrs![hrefIndex][1] = obsidianUri;
						}
					}
					return self.renderToken(tokens, idx, options);
				};

				// Convert markdown to HTML
				let html = md.render(processedContent);

				// Add basic styling
				html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>START</title>
    <style>
        :root {
            color-scheme: light dark;
        }

		img[src*="weather.cgi"] {
			filter: brightness(0.82) invert(0.92);
			display: block;
			margin: 0 auto;
			width: 50%;
		}

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
            background-color: white;
            color: #2e3338;
        }

        a { 
            color: #4A6EE0;
            text-decoration: none;
        }

        a:hover {
            text-decoration: underline;
        }

        /* Obsidian-like dark theme */
        @media (prefers-color-scheme: dark) {
            body {
                background-color: #202020;
                color: #dcddde;
            }

            a {
                color: #7f6df2;
            }

            /* Code blocks */
            pre {
                background-color: #2d2d2d;
                padding: 1em;
                border-radius: 4px;
            }

            code {
                background-color: #2d2d2d;
                padding: 0.2em 0.4em;
                border-radius: 3px;
            }

            /* Blockquotes */
            blockquote {
                border-left: 4px solid #4a4a4a;
                margin: 1em 0;
                padding-left: 1em;
                color: #999;
            }

            /* Horizontal rules */
            hr {
                border: none;
                border-top: 1px solid #4a4a4a;
            }

            /* Tables */
            table {
                border-collapse: collapse;
                margin: 1em 0;
            }

            th, td {
                border: 1px solid #4a4a4a;
                padding: 0.5em 1em;
            }

            th {
                background-color: #2d2d2d;
            }

            /* Lists */
            ul, ol {
                padding-left: 2em;
            }

            /* Task lists */
            input[type="checkbox"] {
                margin-right: 0.5em;
            }
        }
    </style>
</head>
<body>
    ${html}
</body>
</html>`;

				try {
					// Remove any literal backslashes from the path
					const cleanPath = this.settings.startPageExportPath.replace(
						/\\/g,
						""
					);

					// Write the file
					await fs.writeFile(cleanPath, html, "utf8");
					new Notice("START page exported successfully");
				} catch (error) {
					console.error("Error exporting START page:", error);
					new Notice(
						"Error exporting START page. Check console for details."
					);
				}
			},
		});

		// Add settings tab
		this.addSettingTab(new MyPluginSettingTab(this.app, this));
	}

	async onunload() {
		console.log("unloading plugin");
	}

	private addMobileScrollButton() {
		// Only proceed if we're on mobile
		if (!this.app.isMobile) return;

		// Find the mobile toolbar
		const mobileToolbar = document.querySelector('.mobile-toolbar');
		if (!mobileToolbar) return;

		// Remove existing button if it exists
		const existingButton = mobileToolbar.querySelector('.scroll-to-bottom-button');
		if (existingButton) {
			existingButton.remove();
		}

		// Create the button
		const button = mobileToolbar.createEl('div', {
			cls: ['mobile-toolbar-button', 'scroll-to-bottom-button'],
			attr: {
				'aria-label': 'Scroll to Bottom'
			}
		});

		// Add icon (using Obsidian's down-arrow icon)
		button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`;

		// Add click handler
		button.addEventListener('click', () => {
			const activeLeaf = this.app.workspace.activeLeaf;
			if (activeLeaf?.view?.editor) {
				const editor = activeLeaf.view.editor;
				const lastLine = editor.lastLine();
				editor.scrollIntoView({from: {line: lastLine, ch: 0}, to: {line: lastLine, ch: 0}}, true);
			}
		});
	}

	filenameToTitle(filename: string): string {
		// Remove file extension
		let title = filename.replace(/\.md$/, "");

		// Replace hyphens and underscores with spaces
		title = title.replace(/[-_]/g, " ");

		return title;
	}

	getFrontmatter(content: string): Frontmatter | null {
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		if (!match) return null;

		const frontmatter: Frontmatter = {};
		const lines = match[1].split("\n");
		let currentKey = "";

		for (const line of lines) {
			if (line.includes(":")) {
				const [key, ...valueParts] = line.split(":");
				currentKey = key.trim();
				const value = valueParts.join(":").trim();

				if (value.startsWith("[") && value.endsWith("]")) {
					frontmatter[currentKey] = value
						.slice(1, -1)
						.split(",")
						.map((s) => s.trim());
				} else {
					frontmatter[currentKey] = value;
				}
			} else if (line.trim().startsWith("-") && currentKey) {
				if (!Array.isArray(frontmatter[currentKey])) {
					frontmatter[currentKey] = [];
				}
				(frontmatter[currentKey] as string[]).push(
					line.trim().slice(1).trim()
				);
			}
		}

		return frontmatter;
	}

	async fileExistsWithSameSize(
		sourcePath: string,
		destPath: string
	): Promise<boolean> {
		try {
			const [sourceStats, destStats] = await Promise.all([
				fs.stat(sourcePath),
				fs.stat(destPath),
			]);
			return sourceStats.size === destStats.size;
		} catch (error) {
			return false; // File doesn't exist or other error
		}
	}

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

class MyPluginSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("START Page Export Path")
			.setDesc("Path where the START page HTML will be exported")
			.addText((text) =>
				text
					.setPlaceholder("/path/to/export/start.html")
					.setValue(this.plugin.settings.startPageExportPath)
					.onChange(async (value) => {
						this.plugin.settings.startPageExportPath = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
