import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

interface MyPluginSettings {
    mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
    mySetting: 'default'
}

export default class MyPlugin extends Plugin {
    settings: MyPluginSettings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'publish-post',
            name: 'publish to notes.site',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                console.log('command:publish')
                
                const file = view?.file;
                if (!file) return;

                const path = file.path;
                const parts = path.split('/');
                const filename = parts[parts.length - 1];
                
                // Check if it's a daily note
                const date = filename.split('.')[0];
                if (date.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    console.log('daily file detected, skipping');
                    return;
                }
                
                // Get file content
                const content = editor.getDoc().getValue();

				const frontmatter = this.getFrontmatter(content);
				if (!frontmatter || !frontmatter.tags || !frontmatter.tags.includes("#publish")) {
					console.log('no #publish tag in frontmatter detected, skipping');
					return;
				}

                // Convert filename to title
                const title = this.filenameToTitle(filename);

                const response = await fetch('https://jonbo-notessiteingest.web.val.run', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        id: Date.now(),
                        title: title,
                        content: btoa(encodeURIComponent(content))
                    })
                });
                console.log({response})
            }
        });
    }

    filenameToTitle(filename: string): string {
        // Remove file extension
        let title = filename.replace(/\.md$/, '');
        
        // Replace hyphens and underscores with spaces
        title = title.replace(/[-_]/g, ' ');
        
        return title;
    }


	getFrontmatter(content: string): any {
		const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		
		if (match && match[1]) {
			const frontmatter = {};
			const lines = match[1].split('\n');
			let currentKey = '';
	
			for (const line of lines) {
				if (line.trim() === '') continue;
				
				if (line.startsWith('  - ')) {
					// Handle list items
					if (!Array.isArray(frontmatter[currentKey])) {
						frontmatter[currentKey] = [];
					}
					frontmatter[currentKey].push(line.substr(4).trim().replace(/^"(.*)"$/, '$1'));
				} else if (line.includes(':')) {
					// Handle key-value pairs
					const [key, ...valueParts] = line.split(':');
					currentKey = key.trim();
					const value = valueParts.join(':').trim().replace(/^"(.*)"$/, '$1');
					frontmatter[currentKey] = value || [];
				}
			}
			return frontmatter;
		}
		
		return null;
	}

    onunload() {}

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
