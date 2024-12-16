import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, SearchComponent, TFile, TAbstractFile, MarkdownFileInfo, EventRef, TextAreaComponent } from 'obsidian';
import { SearchIndex } from './src/searchIndex';
import { NLPProcessor } from './src/nlpProcessor';
import type { IndexedFile } from './src/searchIndex';

interface MyPluginSettings {
	mySetting: string;
	isVaultIndexed: boolean;
	excludedFolders: string[];
	excludedTags: string[];
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	isVaultIndexed: false,
	excludedFolders: [],
	excludedTags: []
}

class SearchModal extends Modal {
	private searchComponent: SearchComponent;
	private resultsDiv: HTMLDivElement;
	private searchIndex: SearchIndex;
	private currentQuery: string = '';

	constructor(app: App, searchIndex: SearchIndex) {
		super(app);
		this.searchIndex = searchIndex;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		// Create search container
		const searchContainer = contentEl.createDiv('search-container');
		searchContainer.style.padding = '10px';
		searchContainer.style.display = 'flex';
		searchContainer.style.flexDirection = 'column';
		searchContainer.style.gap = '10px';

		// Add search input
		this.searchComponent = new SearchComponent(searchContainer);
		this.searchComponent.setPlaceholder('Type to search...');
		
		// Create results container
		this.resultsDiv = contentEl.createDiv('search-results');
		this.resultsDiv.style.maxHeight = '400px';
		this.resultsDiv.style.overflow = 'auto';
		this.resultsDiv.style.padding = '10px';

		// Handle search input
		this.searchComponent.inputEl.addEventListener('input', () => {
			this.currentQuery = this.searchComponent.getValue();
			this.updateResults();
		});

		// Focus search input
		this.searchComponent.inputEl.focus();
	}

	private updateResults() {
		const query = this.currentQuery;
		console.log('Search query:', query);
		
		if (query.length === 0) {
			console.log('Empty query, showing default message');
			this.resultsDiv.empty();
			this.resultsDiv.createDiv().setText('Start typing to search...');
			return;
		}

		console.log('Performing search with query:', query);
		const results = this.searchIndex.search(query);
		console.log('Search results:', results);
		
		this.resultsDiv.empty();
		
		if (results.length === 0) {
			console.log('No results found');
			this.resultsDiv.createDiv().setText('No results found');
			return;
		}

		console.log(`Displaying ${results.length} results`);

		results.forEach(file => {
			const resultDiv = this.resultsDiv.createDiv('search-result');
			resultDiv.style.padding = '8px';
			resultDiv.style.margin = '4px 0';
			resultDiv.style.borderRadius = '4px';
			resultDiv.style.cursor = 'pointer';
			resultDiv.style.backgroundColor = 'var(--background-secondary)';

			// Add hover effect
			resultDiv.addEventListener('mouseenter', () => {
				resultDiv.style.backgroundColor = 'var(--background-modifier-hover)';
			});
			resultDiv.addEventListener('mouseleave', () => {
				resultDiv.style.backgroundColor = 'var(--background-secondary)';
			});

			// Title
			const titleEl = resultDiv.createDiv('search-result-title');
			titleEl.setText(file.filename);
			titleEl.style.fontWeight = 'bold';
			titleEl.style.marginBottom = '4px';

			// Match reason (in italics)
			const matchReason = resultDiv.createDiv('search-result-reason');
			matchReason.style.fontStyle = 'italic';
			matchReason.style.fontSize = '0.9em';
			matchReason.style.color = 'var(--text-muted)';
			
			// Get match reason
			const reason = this.getMatchReason(file, query);
			matchReason.setText(reason);

			// Click handler to open the file
			resultDiv.addEventListener('click', async () => {
				const targetFile = this.app.vault.getAbstractFileByPath(file.path);
				if (targetFile instanceof TFile) {
					await this.app.workspace.getLeaf().openFile(targetFile);
					this.close();
				}
			});
		});
	}

	private getMatchReason(file: IndexedFile, query: string): string {
		const lowerQuery = query.toLowerCase().trim();
		const lowerTitle = file.filename.toLowerCase();
		const content = file.processed.tokens.join(' ');
		const headers = file.structuredContent.headers;

		// Helper function to highlight keywords in text
		const highlightKeywords = (text: string, terms: string[]): string => {
			let result = text;
			terms.forEach(term => {
				const regex = new RegExp(`(${term})`, 'gi');
				result = result.replace(regex, '**$1**');
			});
			return result;
		};

		// Helper function to find the line containing the match
		const findMatchingLine = (text: string, searchTerms: string[]): string | null => {
			const lines = text.split('\n');
			const matchingLine = lines.find(line => 
				searchTerms.some(term => 
					line.toLowerCase().includes(term.toLowerCase()))
			);
			return matchingLine ? matchingLine.trim() : null;
		};

		// Helper function to get a concise preview
		const getPreview = (text: string, searchTerms: string[]): string => {
			const lines = text.split('\n')
				.map(line => line.trim())
				.filter(line => line.length > 0);
			
			// Find up to two lines containing any of the search terms
			const matchingLines = lines.filter(line => 
				searchTerms.some(term => 
					line.toLowerCase().includes(term.toLowerCase()))
			).slice(0, 2);

			if (matchingLines.length === 0) {
				// If no matches, return first non-empty line
				return lines[0] ? lines[0].slice(0, 100) + "..." : "Empty note";
			}

			// Join matching lines and highlight terms
			return highlightKeywords(
				matchingLines.join(' | ').slice(0, 150) + (matchingLines.join(' ').length > 150 ? "..." : ""),
				searchTerms
			);
		};

		// For title matches
		if (lowerTitle === lowerQuery || lowerTitle.includes(lowerQuery)) {
			const matchingLine = findMatchingLine(content, [lowerQuery]);
			if (matchingLine) {
				return highlightKeywords(matchingLine, [lowerQuery]);
			}
			return "Empty note";
		}

		// Check headers
		const matchingHeader = headers.find(h => 
			h.toLowerCase().includes(lowerQuery));
		if (matchingHeader) {
			return highlightKeywords(matchingHeader, [lowerQuery]);
		}

		// Check for exact content match
		const matchingLine = findMatchingLine(content, [lowerQuery]);
		if (matchingLine) {
			if (matchingLine.length > 150) {
				const words = matchingLine.split(/\s+/);
				const matchIndex = words.findIndex(w => 
					w.toLowerCase().includes(lowerQuery));
				if (matchIndex !== -1) {
					const start = Math.max(0, matchIndex - 5);
					const end = Math.min(words.length, matchIndex + 6);
					return `...${highlightKeywords(words.slice(start, end).join(' '), [lowerQuery])}...`;
				}
			}
			return highlightKeywords(matchingLine, [lowerQuery]);
		}

		// For semantic matches, find relevant lines with related terms
		const relatedTerms = Object.entries(this.searchIndex.getEmotionMap())
			.filter(([emotion, terms]) => 
				emotion === lowerQuery || terms.includes(lowerQuery))
			.flatMap(([emotion, terms]) => [emotion, ...terms]);

		if (relatedTerms.length > 0) {
			return getPreview(content, [lowerQuery, ...relatedTerms]);
		}

		// Fallback to first line with some content
		const firstNonEmptyLine = content.split('\n')
			.find(line => line.trim().length > 0);
		return firstNonEmptyLine ? 
			(firstNonEmptyLine.length > 150 ? firstNonEmptyLine.slice(0, 150) + "..." : firstNonEmptyLine) 
			: "Empty note";
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class IndexingModal extends Modal {
	private resolve: (value: boolean) => void;
	private totalFiles: number;

	constructor(app: App, totalFiles: number) {
		super(app);
		this.totalFiles = totalFiles;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		const container = contentEl.createDiv('indexing-modal-container');
		container.style.padding = '20px';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.gap = '20px';
		container.style.textAlign = 'center';

		const title = container.createEl('h2');
		title.setText('Index Your Vault');

		const message = container.createDiv();
		message.setText(`Your vault contains ${this.totalFiles} files. Would you like to index them now for smart search? This process may take a few minutes for large vaults.`);

		const buttonContainer = container.createDiv();
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'center';
		buttonContainer.style.gap = '10px';

		const indexButton = buttonContainer.createEl('button', { text: 'Index Now' });
		indexButton.style.padding = '8px 16px';
		indexButton.addEventListener('click', () => {
			this.resolve(true);
			this.close();
		});

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.style.padding = '8px 16px';
		cancelButton.addEventListener('click', () => {
			this.resolve(false);
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	async waitForChoice(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}
}

export default class MyPlugin extends Plugin {
	private searchIndex: SearchIndex | null = null;
	settings: MyPluginSettings;
	private loadingNotice: Notice | null = null;
	private fileWatcher: EventRef | null = null;
	private progressBar: HTMLDivElement | null = null;
	private isIndexing: boolean = false;
	private initializationTimeout: NodeJS.Timeout | null = null;

	async onload() {
		console.log('Loading Smart Search plugin...');
		
		// Load settings first
		await this.loadSettings();

		// Initialize search index immediately
		if (!this.searchIndex) {
			this.searchIndex = new SearchIndex(this.app.vault, new NLPProcessor('deep'));
			// Apply exclusion settings
			this.searchIndex.setExclusions(
				this.settings.excludedFolders,
				this.settings.excludedTags
			);
		}

		// Add commands immediately so the plugin is responsive
		this.addCommands();

		// If the vault isn't indexed, show the indexing modal
		if (!this.settings.isVaultIndexed) {
			const markdownFiles = this.app.vault.getMarkdownFiles();
			const indexingModal = new IndexingModal(this.app, markdownFiles.length);
			indexingModal.open();
			
			const shouldIndex = await indexingModal.waitForChoice();
			if (shouldIndex) {
				try {
					await this.buildIndex();
					this.settings.isVaultIndexed = true;
					await this.saveSettings();
					new Notice('Vault indexing completed successfully!');
				} catch (error) {
					console.error('Error during initial indexing:', error);
					new Notice('Error during initial indexing. Please try re-indexing from the plugin settings.');
				}
			} else {
				new Notice('Smart Search will not work until you index your vault. You can do this later from the plugin settings.');
			}
		} else {
			// If already indexed, rebuild the index in the background
			this.buildIndex().catch(error => {
				console.error('Error rebuilding index:', error);
				new Notice('Error rebuilding search index. Please try re-indexing from plugin settings.');
			});
		}

		// Setup file watchers
		this.setupFileWatchers();
	}

	public async buildIndex() {
		if (this.isIndexing) {
			new Notice('Indexing is already in progress');
			return;
		}

		this.isIndexing = true;

		try {
			if (!this.searchIndex) {
				throw new Error('Search index not initialized');
			}

			// Apply current exclusion settings before rebuilding
			this.searchIndex.setExclusions(
				this.settings.excludedFolders,
				this.settings.excludedTags
			);

			// Create progress bar container
			const progressContainer = document.createElement('div');
			progressContainer.style.position = 'fixed';
			progressContainer.style.top = '10px';
			progressContainer.style.left = '50%';
			progressContainer.style.transform = 'translateX(-50%)';
			progressContainer.style.zIndex = '1000';
			progressContainer.style.backgroundColor = 'var(--background-secondary)';
			progressContainer.style.padding = '15px';
			progressContainer.style.borderRadius = '8px';
			progressContainer.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.2)';
			progressContainer.style.width = '300px';

			const progressText = progressContainer.createDiv();
			progressText.style.marginBottom = '8px';
			progressText.style.textAlign = 'center';
			progressText.setText('Indexing your vault...');

			this.progressBar = progressContainer.createDiv();
			this.progressBar.style.width = '100%';
			this.progressBar.style.height = '8px';
			this.progressBar.style.backgroundColor = 'var(--background-modifier-border)';
			this.progressBar.style.borderRadius = '4px';
			this.progressBar.style.overflow = 'hidden';

			const progressFill = this.progressBar.createDiv();
			progressFill.style.width = '0%';
			progressFill.style.height = '100%';
			progressFill.style.backgroundColor = 'var(--interactive-accent)';
			progressFill.style.transition = 'width 0.3s ease';

			const cancelButton = progressContainer.createEl('button', { text: 'Cancel' });
			cancelButton.style.marginTop = '10px';
			cancelButton.style.width = '100%';
			cancelButton.style.padding = '6px';
			cancelButton.addEventListener('click', () => {
				this.cancelIndexing();
			});

			document.body.appendChild(progressContainer);

			console.log('Building initial index...');
			await this.searchIndex.buildInitialIndex((progress) => {
				if (!this.isIndexing) {
					throw new Error('Indexing cancelled');
				}
				if (this.progressBar) {
					const percent = Math.round(progress * 100);
					progressText.setText(`Indexing your vault... ${percent}%`);
					progressFill.style.width = `${percent}%`;
				}
			});

			console.log('Initial index built successfully');
			new Notice('Indexing complete! Smart Search is ready to use.');
			
			// Setup file watchers after initial indexing
			this.setupFileWatchers();
			
		} catch (error) {
			console.error('Error building index:', error);
			if (error.message === 'Indexing cancelled') {
				new Notice('Indexing cancelled');
			} else {
				new Notice('Error building search index. Please try reloading the plugin.');
			}
		} finally {
			this.isIndexing = false;
			if (this.progressBar) {
				this.progressBar.parentElement?.remove();
				this.progressBar = null;
			}
		}
	}

	private cancelIndexing() {
		this.isIndexing = false;
	}

	private addCommands() {
		// Add ribbon icon
		const ribbonIconEl = this.addRibbonIcon('search', 'Smart Search', (evt: MouseEvent) => {
			if (!this.searchIndex) {
				new Notice('Search index not initialized. Please wait a moment and try again.');
				return;
			}
			new SearchModal(this.app, this.searchIndex).open();
		});

		// Add command
		this.addCommand({
			id: 'open-smart-search',
			name: 'Open Smart Search',
			callback: () => {
				if (!this.searchIndex) {
					new Notice('Search index not initialized. Please wait a moment and try again.');
					return;
				}
				new SearchModal(this.app, this.searchIndex).open();
			}
		});

		// Add settings tab
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	private setupFileWatchers() {
		// Watch for file changes
		this.fileWatcher = this.app.vault.on('modify', async (file) => {
			if (!this.searchIndex) return;
			if (file instanceof TFile && file.extension === 'md') {
				console.log(`File modified: ${file.path}`);
				
				// Check if the file was previously excluded
				const wasExcluded = !this.searchIndex.isFileIndexed(file.path);
				
				// Update the file in the index
				await this.searchIndex.updateFile(file);
				
				// If the file was previously excluded but now should be included,
				// notify the user
				if (wasExcluded && this.searchIndex.isFileIndexed(file.path)) {
					new Notice(`File "${file.basename}" is now included in search (exclusion criteria no longer met)`);
				}
			}
		});

		// Watch for new files
		this.app.vault.on('create', async (file) => {
			if (!this.searchIndex) return;
			if (file instanceof TFile && file.extension === 'md') {
				console.log(`New file created: ${file.path}`);
				await this.searchIndex.indexFile(file);
			}
		});

		// Watch for deleted files
		this.app.vault.on('delete', async (file) => {
			if (!this.searchIndex) return;
			if (file instanceof TFile && file.extension === 'md') {
				console.log(`File deleted: ${file.path}`);
				this.searchIndex.removeFile(file.path);
			}
		});

		// Watch for renamed/moved files
		this.app.vault.on('rename', async (file, oldPath) => {
			if (!this.searchIndex) return;
			if (file instanceof TFile && file.extension === 'md') {
				console.log(`File renamed/moved from ${oldPath} to ${file.path}`);
				
				// Check if the file was previously excluded
				const wasExcluded = !this.searchIndex.isFileIndexed(oldPath);
				
				// Remove old path
				this.searchIndex.removeFile(oldPath);
				
				// Index with new path
				await this.searchIndex.indexFile(file);
				
				// If the file was previously excluded but now should be included,
				// notify the user
				if (wasExcluded && this.searchIndex.isFileIndexed(file.path)) {
					new Notice(`File "${file.basename}" is now included in search (moved out of excluded folder)`);
				}
			}
		});
	}

	onunload() {
		// Clear initialization timeout if it exists
		if (this.initializationTimeout) {
				clearTimeout(this.initializationTimeout);
				this.initializationTimeout = null;
		}

		// Clean up file watchers
		if (this.fileWatcher) {
			this.app.vault.offref(this.fileWatcher);
		}
		
		// Clean up any remaining notices
		if (this.loadingNotice) {
			this.loadingNotice.hide();
		}

		// Clean up any remaining UI elements
		if (this.progressBar) {
			this.progressBar.parentElement?.remove();
			this.progressBar = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	private excludedFoldersInput: TextAreaComponent;
	private excludedTagsInput: TextAreaComponent;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Smart Search Settings' });

		// Excluded Folders Setting
		new Setting(containerEl)
			.setName('Excluded Folders')
			.setDesc('Enter folder paths to exclude from search (one per line). Example: "Daily Notes" or "Work/Projects"')
			.addTextArea(text => {
				this.excludedFoldersInput = text;
				text.setValue(this.plugin.settings.excludedFolders.join('\n'))
					.setPlaceholder('Daily Notes\nWork/Projects')
					.onChange(async (value) => {
						const folders = value.split('\n')
							.map(f => f.trim())
							.filter(f => f.length > 0);
						this.plugin.settings.excludedFolders = folders;
					});
				text.inputEl.rows = 4;
				text.inputEl.cols = 25;
			});

		// Excluded Tags Setting
		new Setting(containerEl)
			.setName('Excluded Tags')
			.setDesc('Enter tags to exclude from search (one per line, without #). Example: "private" or "draft"')
			.addTextArea(text => {
				this.excludedTagsInput = text;
				text.setValue(this.plugin.settings.excludedTags.join('\n'))
					.setPlaceholder('private\ndraft')
					.onChange(async (value) => {
						const tags = value.split('\n')
							.map(t => t.trim())
							.filter(t => t.length > 0);
						this.plugin.settings.excludedTags = tags;
					});
				text.inputEl.rows = 4;
				text.inputEl.cols = 25;
			});

		// Save and Reindex Button
		new Setting(containerEl)
			.setName('Save Exclusions and Reindex')
			.setDesc('Save your exclusion settings and rebuild the search index')
			.addButton(button => {
				button.setButtonText('Save and Reindex')
					.onClick(async () => {
						try {
							button.setDisabled(true);
							button.setButtonText('Saving and Reindexing...');
							
							await this.plugin.saveSettings();
							new Notice('Settings saved. Rebuilding search index...');
							await this.plugin.buildIndex();
							
							new Notice('Settings saved and index rebuilt successfully!');
						} catch (error) {
							console.error('Error saving settings and rebuilding index:', error);
							new Notice('Error saving settings. Please try again.');
						} finally {
							button.setDisabled(false);
							button.setButtonText('Save and Reindex');
						}
					});
			});

		// Re-index vault (existing setting)
		new Setting(containerEl)
			.setName('Re-index vault')
			.setDesc('Re-index your vault to update the search index with any changes made while the plugin was disabled.')
			.addButton(button => {
				button.setButtonText('Re-index')
					.onClick(async () => {
						try {
							button.setDisabled(true);
							button.setButtonText('Indexing...');
							
							const markdownFiles = this.app.vault.getMarkdownFiles();
							const indexingModal = new IndexingModal(this.app, markdownFiles.length);
							const shouldIndex = await indexingModal.waitForChoice();

							if (shouldIndex) {
								await this.plugin.buildIndex();
								this.plugin.settings.isVaultIndexed = true;
								await this.plugin.saveSettings();
								new Notice('Vault indexing completed successfully!');
							}
						} catch (error) {
							console.error('Error during indexing:', error);
							new Notice('Error during indexing. Please try again.');
						} finally {
							button.setDisabled(false);
							button.setButtonText('Re-index');
							this.display(); // Refresh the settings view
						}
					});
			});

		if (!this.plugin.settings.isVaultIndexed) {
			containerEl.createEl('div', {
				text: 'Note: Your vault is not currently indexed. Smart Search will not work until you index your vault.',
				cls: 'setting-item-description'
			}).style.color = 'var(--text-error)';
		}
	}
}
