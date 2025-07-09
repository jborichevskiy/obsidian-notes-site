import { Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import * as fs from "fs/promises";
import { App, PluginSettingTab, Setting } from "obsidian";
import markdownit from "markdown-it";
import { Token } from "markdown-it";
import {
	EditorView,
	Decoration,
	ViewPlugin,
	ViewUpdate,
	DecorationSet,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

interface MyPluginSettings {
	mySetting: string;
	startPageExportPath: string;
	progressBarEnabled: boolean;
	dotModeEnabled: boolean;
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
	progressBarEnabled: false,
	dotModeEnabled: false,
};

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	private debounceTimer: NodeJS.Timeout | null = null;
	private dotModeRibbonIcon: HTMLElement | null = null;
	private static instance: MyPlugin;

	private debouncedExportStartPage = (editor: Editor, view: MarkdownView) => {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.exportStartPageHtml(editor, view);
		}, 3000); // 3 second debounce
	};

	async onload() {
		MyPlugin.instance = this;
		await this.loadSettings();

		// Add ribbon icon for dot mode toggle
		this.dotModeRibbonIcon = this.addRibbonIcon(
			"eye",
			"Toggle Dot Mode",
			(evt: MouseEvent) => {
				this.toggleDotMode();
			}
		);

		// Register markdown post processor for dot mode
		this.registerMarkdownPostProcessor((el, ctx) => {
			if (this.settings.dotModeEnabled) {
				this.applyDotMode(el);
			}
		});

		// Register editor extension for source mode
		// Register editor extension for source mode
		this.registerEditorExtension([
			ViewPlugin.fromClass(
				class {
					decorations: DecorationSet;

					constructor(view: EditorView) {
						this.decorations = this.buildDecorations(view);
					}

					update(update: ViewUpdate) {
						if (update.docChanged || update.viewportChanged) {
							this.decorations = this.buildDecorations(
								update.view
							);
						}
					}

					buildDecorations(view: EditorView) {
						if (!MyPlugin.instance?.settings?.dotModeEnabled) {
							return Decoration.none;
						}

						const builder = new RangeSetBuilder<Decoration>();

						// Array of punctuation characters to show
						const punctuationToShow = [
							".",
							",",
							'"',
							":",
							"-",
							";",
							"!",
							"?",
						];

						// Iterate through the visible content
						for (const { from, to } of view.visibleRanges) {
							const text = view.state.doc.sliceString(from, to);
							let pos = 0;

							while (pos < text.length) {
								const char = text[pos];
								const absPos = from + pos;

								// First check if it's a punctuation mark we want to show
								if (punctuationToShow.includes(char)) {
									builder.add(
										absPos,
										absPos + 1,
										Decoration.mark({
											class: "cm-dot-mode-punct",
										})
									);
								} else if (char === " ") {
									// Style spaces differently
									builder.add(
										absPos,
										absPos + 1,
										Decoration.mark({
											class: "cm-dot-mode-space",
										})
									);
								} else {
									// Style regular characters as dots
									builder.add(
										absPos,
										absPos + 1,
										Decoration.mark({
											class: "cm-dot-mode-char",
										})
									);
								}
								pos++;
							}
						}

						return builder.finish();
					}
				},
				{
					decorations: (v) => v.decorations,
				}
			),
		]);

		// Add command for toggling dot mode
		this.addCommand({
			id: "toggle-dot-mode",
			name: "Toggle Dot Mode",
			callback: () => {
				this.toggleDotMode();
			},
		});

		// Register the mobile toolbar button when layout changes
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.addMobileScrollButton();
				this.addMobileDotModeButton();
			})
		);

		// Register editor change event for START page auto-export
		this.registerEvent(
			this.app.workspace.on(
				"editor-change",
				(editor: Editor, view: MarkdownView) => {
					if (view?.file?.basename === "START") {
						this.debouncedExportStartPage(editor, view);
					}
				}
			)
		);

		// Add command for manual export
		this.addCommand({
			id: "export-start-page",
			name: "Export START page to HTML",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.exportStartPageHtml(editor, view);
			},
		});

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

				// Handle images with captions
				const lines = content.split('\n');
				const processedLines: string[] = [];
				let i = 0;
				
				while (i < lines.length) {
					const line = lines[i];
					const imageMatch = line.match(/!\[\[(.*?)\]\]/);
					
					if (imageMatch) {
						const imageName = imageMatch[1];
						const sourceFile = this.app.vault.getAbstractFileByPath(imageName);
						
						if (sourceFile instanceof TFile) {
							const vaultPath = (this.app.vault.adapter as any).basePath;
							const sourcePath = `${vaultPath}/${sourceFile.path}`;
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

								// Check if next line exists and is a potential caption
								let caption = "";
								if (i + 1 < lines.length && lines[i + 1].trim() !== "" && !lines[i + 1].match(/!\[\[.*?\]\]/)) {
									// Check if line after that is empty (indicating this is a caption)
									if (i + 2 >= lines.length || lines[i + 2].trim() === "") {
										caption = lines[i + 1].trim();
										i++; // Skip the caption line
									}
								}

								const assembledFigure = `{{<figure src="/${imageName}" caption="${caption}">}}\n`;
								processedLines.push(assembledFigure);
								console.log({ assembledFigure });
							} catch (error) {
								console.error(
									`Error copying image ${imageName}:`,
									error
								);
								processedLines.push(line); // Keep original line on error
							}
						} else {
							console.error(`Image not found in vault: ${imageName}`);
							processedLines.push(line); // Keep original line if image not found
						}
					} else {
						processedLines.push(line);
					}
					i++;
				}
				
				content = processedLines.join('\n');

				//todo: figure out whether to put this in /posts or / at the root

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

		// Add settings tab
		this.addSettingTab(new MyPluginSettingTab(this.app, this));
	}

	private async exportStartPageHtml(editor: Editor, view: MarkdownView) {
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
				// Add style attribute for dotted underline with transition
				token.attrPush([
					"style",
					"text-decoration: none; border-bottom: 1px solid rgba(128, 128, 128, 0.6);",
				]);
				token.attrPush([
					"onmouseover",
					`this.style.borderBottom = '2px dotted rgba(128, 128, 128, 0.6)';`,
				]);
				token.attrPush([
					"onmouseout",
					`this.style.borderBottom = '1px solid rgba(128, 128, 128, 0.6)';`,
				]);
				if (href && href.startsWith("[[") && href.endsWith("]]")) {
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

		.progress-bar {
			position: fixed;
			top: 0;
			left: 0;
			height: 1.5px;
			background-color: rgba(147, 112, 219, 0.6);
			width: 0%;
			transition: width 100ms cubic-bezier(0.4, 0, 0.2, 1);
			z-index: 1000;
		}

		.progress-toggle {
			position: fixed;
			bottom: 20px;
			left: 20px;
			padding: 8px 12px;
			background-color: rgba(147, 112, 219, 0.1);
			border: 1px solid rgba(147, 112, 219, 0.2);
			border-radius: 4px;
			color: rgba(147, 112, 219, 0.8);
			cursor: pointer;
			font-size: 12px;
			transition: all 0.2s ease;
			z-index: 1000;
		}

		.progress-toggle:hover {
			background-color: rgba(147, 112, 219, 0.2);
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
        </style>
	<script>
		// Progress bar animation
		document.addEventListener('DOMContentLoaded', () => {
			const progressBar = document.createElement('div');
			progressBar.className = 'progress-bar';
			document.body.appendChild(progressBar);

			const toggle = document.createElement('button');
			toggle.className = 'progress-toggle';
			toggle.textContent = 'breath timer';
			document.body.appendChild(toggle);

			let enabled = localStorage.getItem('progressEnabled') === 'true';
			let animation = null;

			const updateProgressBar = () => {
				if (enabled) {
					startAnimation();
				} else {
					stopAnimation();
				}
			};

			const startAnimation = () => {
				if (animation) return;

				const duration = 5500;
				const startTime = Date.now();

				const animate = () => {
					const elapsed = (Date.now() - startTime) % (duration * 2);
					const halfCycle = elapsed < duration;
					let progress = (elapsed % duration) / duration;

					// Smooth out the transitions by adjusting the progress curve
					if (halfCycle) {
						// Ease in more gradually at the start
						progress = progress * 0.97 + 0.03;
					} else {
						// Keep the smooth transition on the way down
						progress = 1 - progress;
					}

					// Apply enhanced easing for more pronounced breathing effect
					const easeProgress = easeInOutQuint(progress);
					progressBar.style.width = \`\${easeProgress * 100}%\`;
					animation = requestAnimationFrame(animate);
				};

				animation = requestAnimationFrame(animate);
			};

			const stopAnimation = () => {
				if (animation) {
					cancelAnimationFrame(animation);
					animation = null;
				}
				progressBar.style.width = '0%';
			};

			// Enhanced easing function for steeper edges and slower middle
			const easeInOutQuint = (x) => {
				return x < 0.5
					? 16 * x * x * x * x * x
					: 1 - Math.pow(-2 * x + 2, 5) / 2;
			};

			toggle.addEventListener('click', () => {
				enabled = !enabled;
				localStorage.setItem('progressEnabled', enabled);
				updateProgressBar();
			});

			// Initialize state
			updateProgressBar();
		});
	</script>
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
	}

	private addMobileScrollButton() {
		// Only proceed if we're on mobile
		// if (!this.app.isMobile) return;

		// Find the mobile toolbar
		const mobileToolbar = document.querySelector(".mobile-toolbar");
		if (!mobileToolbar) return;

		// Remove existing button if it exists
		const existingButton = mobileToolbar.querySelector(
			".scroll-to-bottom-button"
		);
		if (existingButton) {
			existingButton.remove();
		}

		// Create the button
		const button = mobileToolbar.createEl("div", {
			cls: ["mobile-toolbar-button", "scroll-to-bottom-button"],
			attr: {
				"aria-label": "Scroll to Bottom",
			},
		});

		// Add icon (using Obsidian's down-arrow icon)
		button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`;

		// Add click handler
		button.addEventListener("click", () => {
			const activeLeaf = this.app.workspace.activeLeaf;
			if (activeLeaf?.view instanceof MarkdownView) {
				const editor = activeLeaf.view.editor;
				const lastLine = editor.lastLine();
				editor.scrollIntoView(
					{
						from: { line: lastLine, ch: 0 },
						to: { line: lastLine, ch: 0 },
					},
					true
				);
			}
		});
	}

	private addMobileDotModeButton() {
		// Find the mobile toolbar
		const mobileToolbar = document.querySelector(".mobile-toolbar");
		if (!mobileToolbar) return;

		// Remove existing button if it exists
		const existingButton = mobileToolbar.querySelector(".dot-mode-button");
		if (existingButton) {
			existingButton.remove();
		}

		// Create the button
		const button = mobileToolbar.createEl("div", {
			cls: ["mobile-toolbar-button", "dot-mode-button"],
			attr: {
				"aria-label": "Toggle Dot Mode",
			},
		});

		// Add icon (using Obsidian's eye icon)
		button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;

		// Add click handler
		button.addEventListener("click", () => {
			this.toggleDotMode();
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

	// Toggle dot mode on/off
	toggleDotMode() {
		// Toggle the setting
		this.settings.dotModeEnabled = !this.settings.dotModeEnabled;

		// Force refresh of all views
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				// Force editor to update decorations by simulating a change
				const editorView = (leaf.view.editor as any).cm as EditorView;
				const doc = editorView.state.doc;
				editorView.dispatch({
					changes: {
						from: 0,
						to: doc.length,
						insert: doc.sliceString(0, doc.length),
					},
				});

				// Rerender preview if in preview mode
				if (leaf.view.getMode() === "preview") {
					leaf.view.previewMode.rerender(true);
				}
			}
		});

		// Update UI elements
		const rootEl = document.body;
		if (this.settings.dotModeEnabled) {
			rootEl.classList.add("dot-mode-enabled");
			new Notice("Dot mode enabled");

			if (this.dotModeRibbonIcon) {
				this.dotModeRibbonIcon.addClass("is-active");
			}

			const mobileButton = document.querySelector(".dot-mode-button");
			if (mobileButton) {
				mobileButton.addClass("is-active");
			}
		} else {
			rootEl.classList.remove("dot-mode-enabled");
			new Notice("Dot mode disabled");

			if (this.dotModeRibbonIcon) {
				this.dotModeRibbonIcon.removeClass("is-active");
			}

			const mobileButton = document.querySelector(".dot-mode-button");
			if (mobileButton) {
				mobileButton.removeClass("is-active");
			}
		}

		// Save settings
		this.saveSettings();
	}

	private applyDotMode(element: HTMLElement) {
		const textNodes = this.getTextNodes(element);
		textNodes.forEach((node) => {
			const span = document.createElement("span");
			span.classList.add("dot-mode-text");

			// Create a separate span for each character
			const text = node.textContent || "";
			text.split("").forEach((char) => {
				const charSpan = document.createElement("span");
				if (char === " ") {
					charSpan.classList.add("dot-mode-space");
					charSpan.textContent = char;
				} else {
					charSpan.classList.add("dot-mode-char");
					charSpan.textContent = char;
				}
				span.appendChild(charSpan);
			});

			node.parentNode?.replaceChild(span, node);
		});
	}

	private getTextNodes(node: Node): Text[] {
		const textNodes: Text[] = [];
		const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
			acceptNode: function (node) {
				// Skip nodes that are part of a code block
				if (node.parentElement?.closest("pre, code")) {
					return NodeFilter.FILTER_REJECT;
				}
				// Skip empty or whitespace-only nodes
				if (!node.textContent || !node.textContent.trim()) {
					return NodeFilter.FILTER_REJECT;
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});

		let currentNode: Node | null;
		while ((currentNode = walker.nextNode()) !== null) {
			textNodes.push(currentNode as Text);
		}
		return textNodes;
	}

	onunload() {
		// Clean up dot mode if enabled
		if (this.settings.dotModeEnabled) {
			document.body.classList.remove("dot-mode-enabled");
		}

		// Remove mobile dot mode button if it exists
		const mobileButton = document.querySelector(".dot-mode-button");
		if (mobileButton) {
			mobileButton.remove();
		}
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

		new Setting(containerEl)
			.setName("Progress Bar")
			.setDesc("Enable or disable the progress bar")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.progressBarEnabled)
					.onChange(async (value) => {
						this.plugin.settings.progressBarEnabled = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
