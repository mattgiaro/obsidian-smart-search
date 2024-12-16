import { TFile, Vault } from 'obsidian';
import { NLPProcessor, ProcessedText, ProcessedQuery } from './nlpProcessor';

interface IndexedFile {
    path: string;
    filename: string;
    lastModified: number;
    processed: ProcessedText;
    tags: string[];
    frontmatter: Record<string, any>;
    tableContent: string[];
    structuredContent: {
        headers: string[];
        lists: string[];
        tables: Array<{
            headers: string[];
            rows: string[][];
        }>;
    };
}

interface TableMatch {
    headers: string[];
    rows: string[][];
}

export class SearchIndex {
    private index: Map<string, IndexedFile>;
    private nlpProcessor: NLPProcessor;
    private vault: Vault;
    
    private readonly emotionMap: Record<string, string[]> = {
        'anger': ['rage', 'fury', 'pissed-off', 'angry', 'mad', 'irritated'],
        'fear': ['anxiety', 'anxious', 'scared', 'terrified', 'worried'],
        'joy': ['happy', 'joyous', 'play', 'playful', 'excited', 'enthusiastic'],
        'sadness': ['sad', 'lonely', 'panic', 'depressed', 'melancholy'],
        'love': ['care', 'tender', 'loving', 'affection', 'attachment'],
        'desire': ['lust', 'horny', 'wanting', 'craving', 'yearning']
    };

    constructor(vault: Vault, nlpProcessor: NLPProcessor) {
        this.vault = vault;
        this.nlpProcessor = nlpProcessor;
        this.index = new Map();
    }

    private getRelatedTerms(term: string): string[] {
        const lowerTerm = term.toLowerCase();
        for (const [emotion, related] of Object.entries(this.emotionMap)) {
            if (emotion === lowerTerm || related.some(r => r.toLowerCase() === lowerTerm)) {
                return [emotion, ...related];
            }
        }
        return [];
    }

    private parseMarkdownContent(content: string): IndexedFile['structuredContent'] {
        const structure: IndexedFile['structuredContent'] = {
            headers: [],
            lists: [],
            tables: []
        };

        const headerRegex = /^#{1,6}\s+(.+)$/gm;
        let match: RegExpExecArray | null;
        while ((match = headerRegex.exec(content)) !== null) {
            structure.headers.push(match[1].trim());
        }

        const listRegex = /^[-*+]\s+(.+)$/gm;
        while ((match = listRegex.exec(content)) !== null) {
            structure.lists.push(match[1].trim());
        }

        const tableRegex = /\|(.+)\|\n\|[-|\s]+\|\n((?:\|.+\|\n?)+)/gm;
        while ((match = tableRegex.exec(content)) !== null) {
            const headers = match[1].split('|').map(h => h.trim()).filter(Boolean);
            const rows = match[2]
                .split('\n')
                .filter(row => row.trim())
                .map(row => 
                    row.split('|')
                        .map(cell => cell.trim())
                        .filter(Boolean)
                );
            
            structure.tables.push({ headers, rows });
        }

        return structure;
    }

    async buildInitialIndex(progressCallback?: (progress: number) => void): Promise<void> {
        const markdownFiles = this.vault.getMarkdownFiles();
        console.log(`Starting to index ${markdownFiles.length} files`);
        
        let processed = 0;
        const total = markdownFiles.length;
        
        for (const file of markdownFiles) {
            try {
                await this.indexFile(file);
                processed++;
                
                if (progressCallback) {
                    progressCallback(processed / total);
                }
            } catch (error) {
                console.error(`Error indexing file ${file.path}:`, error);
                // Continue with other files even if one fails
            }
        }
        
        console.log(`Indexed ${this.index.size} files successfully`);
        console.log('Index contents:', Array.from(this.index.keys()));
    }

    async indexFile(file: TFile): Promise<void> {
        try {
            console.log(`Reading file: ${file.path}`);
            const content = await this.vault.cachedRead(file);
            
            const structuredContent = this.parseMarkdownContent(content);
            
            const tableContent = structuredContent.tables.flatMap(table => [
                ...table.headers,
                ...table.rows.flat()
            ]);

            const processed = this.nlpProcessor.processText(content);
            
            const tags = this.extractTags(content);
            const frontmatter = this.extractFrontmatter(content);
            
            this.index.set(file.path, {
                path: file.path,
                filename: file.basename,
                lastModified: file.stat.mtime,
                processed,
                tags,
                frontmatter,
                tableContent,
                structuredContent
            });
        } catch (error) {
            console.error(`Error indexing file ${file.path}:`, error);
            throw error;
        }
    }

    async updateFile(file: TFile): Promise<void> {
        // Only update if the file has actually changed
        const existingFile = this.index.get(file.path);
        if (existingFile && existingFile.lastModified === file.stat.mtime) {
            console.log(`File ${file.path} hasn't changed, skipping update`);
            return;
        }
        
        await this.indexFile(file);
    }

    removeFile(path: string): void {
        this.index.delete(path);
        console.log(`Removed ${path} from index`);
    }

    search(query: string): IndexedFile[] {
        if (query.length < 2) return [];
        
        const processedQuery = this.nlpProcessor.processQuery(query);
        const results = this.rankResults(processedQuery);
        return results.slice(0, 50); // Limit results to improve performance
    }

    private rankResults(query: ProcessedQuery): IndexedFile[] {
        const results: Array<{ file: IndexedFile; score: number }> = [];
        
        // Get all search terms including related terms
        const searchTerms = new Set([
            ...query.keywords,
            ...query.relatedTerms,
            ...query.keywords.flatMap(term => this.getRelatedTerms(term))
        ]);

        // Early return if no search terms
        if (searchTerms.size === 0) return [];

        // Convert search terms to lowercase once
        const lowerSearchTerms = Array.from(searchTerms).map(term => term.toLowerCase());

        for (const file of this.index.values()) {
            const score = this.calculateRelevanceScore(file, query, lowerSearchTerms);
            if (score > 0) {
                results.push({ file, score });
            }

            // Early return if we have enough high-quality results
            if (results.length >= 100) break;
        }

        // Sort by score descending and return top results
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, 50)
            .map(result => result.file);
    }

    private calculateRelevanceScore(
        file: IndexedFile, 
        query: ProcessedQuery, 
        lowerSearchTerms: string[]
    ): number {
        let score = 0;
        const content = file.processed.tokens.join(' ').toLowerCase();
        
        // Quick check if any term exists in content
        if (!lowerSearchTerms.some(term => content.includes(term))) {
            return 0;
        }

        const checkWordBoundary = (text: string, term: string): boolean => {
            const regex = new RegExp(`\\b${term}\\b`, 'i');
            return regex.test(text);
        };

        // Cache filename and headers in lowercase
        const lowerFilename = file.filename.toLowerCase();
        const lowerHeaders = file.structuredContent.headers.map(h => h.toLowerCase());

        for (const lowerTerm of lowerSearchTerms) {
            let termScore = 0;

            // Check filename first (most important)
            if (checkWordBoundary(lowerFilename, lowerTerm)) {
                termScore += 2;
                // If found in filename, skip other checks for this term
                score += termScore;
                continue;
            }

            // Check headers next (second most important)
            if (lowerHeaders.some(header => checkWordBoundary(header, lowerTerm))) {
                termScore += 3;
                // If found in headers with good score, skip other checks
                if (termScore >= 3) {
                    score += termScore;
                    continue;
                }
            }

            // Only check content if we haven't found good matches above
            if (checkWordBoundary(content, lowerTerm)) {
                termScore += 1;
            } else if (content.includes(lowerTerm)) {
                termScore += 0.5;
            }

            // Only check tables if we haven't found good matches yet
            if (termScore < 2) {
                for (const tableText of file.tableContent) {
                    if (checkWordBoundary(tableText.toLowerCase(), lowerTerm)) {
                        termScore += 2;
                        break; // Exit table check once we find a match
                    }
                }
            }

            score += termScore;
        }

        // Normalize score based on content length, but with a max cap
        const normalizedScore = score / Math.log(Math.min(content.length, 5000) + 1);
        return normalizedScore;
    }

    private extractTags(content: string): string[] {
        const tagRegex = /#[\w\/-]+/g;
        return Array.from(content.matchAll(tagRegex)).map(match => match[0].toLowerCase());
    }

    private extractFrontmatter(content: string): Record<string, any> {
        const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
        const match = content.match(frontmatterRegex);
        
        if (!match) return {};
        
        try {
            const frontmatter: Record<string, any> = {};
            const lines = match[1].split('\n');
            
            for (const line of lines) {
                const [key, ...valueParts] = line.split(':');
                if (key && valueParts.length) {
                    frontmatter[key.trim()] = valueParts.join(':').trim();
                }
            }
            
            return frontmatter;
        } catch (error) {
            console.error('Error parsing frontmatter:', error);
            return {};
        }
    }
}