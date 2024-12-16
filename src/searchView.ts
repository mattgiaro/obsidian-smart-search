import { ItemView, WorkspaceLeaf, App } from 'obsidian';
import { SearchIndex } from './searchIndex';
import { NLPProcessor } from './nlpProcessor';

export class SearchView extends ItemView {
    searchIndex: SearchIndex;
    nlpProcessor: NLPProcessor;
    searchInput: HTMLInputElement;
    resultsContainer: HTMLElement;
    debounceTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(leaf: WorkspaceLeaf, searchIndex: SearchIndex, nlpProcessor: NLPProcessor) {
        super(leaf);
        this.searchIndex = searchIndex;
        this.nlpProcessor = nlpProcessor;
    }

    getViewType(): string {
        return 'smart-search';
    }

    getDisplayText(): string {
        return 'Smart Search';
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // Create search input
        const searchContainer = contentEl.createDiv({ cls: 'search-container' });
        this.searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search your notes...'
        });
        this.searchInput.addEventListener('input', () => this.handleSearch());

        // Create results container
        this.resultsContainer = contentEl.createDiv({ cls: 'search-results' });
    }

    private handleSearch(): void {
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }

        const query = this.searchInput.value.trim();
        
        // Clear results if query is too short
        if (query.length < 2) {
            this.resultsContainer.empty();
            const messageDiv = this.resultsContainer.createDiv({ cls: 'search-message' });
            messageDiv.setText(query.length === 0 ? 'Type to search...' : 'Enter at least 2 characters...');
            return;
        }

        // Increase debounce time for better performance on large vaults
        this.debounceTimeout = setTimeout(() => {
            try {
                const results = this.searchIndex.search(query);
                this.displayResults(results);
            } catch (error) {
                console.error('Search error:', error);
                this.resultsContainer.empty();
                const errorDiv = this.resultsContainer.createDiv({ cls: 'search-error' });
                errorDiv.setText('An error occurred while searching.');
            }
        }, 400); // Increased from 300ms to 400ms for better performance
    }

    private displayResults(results: any[]): void {
        this.resultsContainer.empty();

        if (results.length === 0) {
            const noResults = this.resultsContainer.createDiv({ cls: 'no-results' });
            noResults.setText('No results found');
            return;
        }

        results.forEach(result => {
            const resultDiv = this.resultsContainer.createDiv({ cls: 'search-result' });
            const titleEl = resultDiv.createEl('div', { cls: 'result-title' });
            titleEl.setText(result.filename);
            
            const pathEl = resultDiv.createEl('div', { cls: 'result-path' });
            pathEl.setText(result.path);

            resultDiv.addEventListener('click', () => {
                this.app.workspace.openLinkText(result.path, '');
            });
        });
    }
}