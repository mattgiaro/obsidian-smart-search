import { TFile, Vault } from 'obsidian';
import { NLPProcessor, ProcessedText, ProcessedQuery } from './nlpProcessor';
import type MyPlugin from '../main';

export interface IndexedFile {
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
    private plugin: MyPlugin;
    private excludedFolders: string[] = [];
    private excludedTags: string[] = [];
    
    private readonly emotionMap: Record<string, string[]> = {
        'anger': ['rage', 'fury', 'pissed-off', 'angry', 'mad', 'irritated'],
        'fear': ['anxiety', 'anxious', 'scared', 'terrified', 'worried'],
        'joy': ['happy', 'joyous', 'play', 'playful', 'excited', 'enthusiastic'],
        'sadness': ['sad', 'lonely', 'panic', 'depressed', 'melancholy'],
        'love': ['care', 'tender', 'loving', 'affection', 'attachment'],
        'desire': ['lust', 'horny', 'wanting', 'craving', 'yearning']
    };

    constructor(vault: Vault, nlpProcessor: NLPProcessor, plugin: MyPlugin) {
        this.vault = vault;
        this.nlpProcessor = nlpProcessor;
        this.plugin = plugin;
        this.index = new Map();
    }

    getEmotionMap(): Record<string, string[]> {
        return this.emotionMap;
    }

    isFileIndexed(path: string): boolean {
        return this.index.has(path);
    }

    setExclusions(excludedFolders: string[], excludedTags: string[]) {
        this.excludedFolders = excludedFolders;
        this.excludedTags = excludedTags;
    }

    private isFileExcluded(file: TFile, tags: string[]): boolean {
        // Check if file is in excluded folder
        const isInExcludedFolder = this.excludedFolders.some(folder => 
            file.path.toLowerCase().startsWith(folder.toLowerCase() + '/'));

        // Check if file has excluded tags
        const hasExcludedTag = this.excludedTags.some(tag => 
            tags.some(fileTag => fileTag.toLowerCase() === '#' + tag.toLowerCase()));

        return isInExcludedFolder || hasExcludedTag;
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
            let content = await this.vault.cachedRead(file);
            const tags = this.extractTags(content);
            
            // Skip indexing if file is excluded
            if (this.isFileExcluded(file, tags)) {
                // Remove from index if it was previously indexed
                this.index.delete(file.path);
                return;
            }
            
            // Remove wiki links content if setting is enabled
            if (this.plugin.settings.excludeWikilinks) {
                content = content.replace(/\[\[([^\]]+)\]\]/g, '');
            }

            const structuredContent = this.parseMarkdownContent(content);
            const tableContent = structuredContent.tables.flatMap(table => [
                ...table.headers,
                ...table.rows.flat()
            ]);

            const processed = this.nlpProcessor.processText(content);
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
        
        const lowerQuery = query.toLowerCase().trim();
        const processedQuery = this.nlpProcessor.processQuery(query);
        
        // Get related terms for semantic search
        const relatedTerms = this.getRelatedTerms(lowerQuery);
        
        // First pass: Find exact title matches
        const exactTitleMatches = this.findExactTitleMatches(lowerQuery);
        
        // Second pass: Find exact content matches
        const exactContentMatches = this.findExactContentMatches(lowerQuery, new Set(exactTitleMatches.map(f => f.path)));
        
        // Third pass: Find semantic title matches
        const semanticTitleMatches = this.findSemanticTitleMatches(lowerQuery, relatedTerms, 
            new Set([...exactTitleMatches, ...exactContentMatches].map(f => f.path)));
        
        // Fourth pass: NLP-based search for remaining files
        const nlpResults = this.rankResults(processedQuery, relatedTerms,
            new Set([...exactTitleMatches, ...exactContentMatches, ...semanticTitleMatches].map(f => f.path)));
        
        // Combine results in priority order
        return [...exactTitleMatches, ...exactContentMatches, ...semanticTitleMatches, ...nlpResults].slice(0, 50);
    }

    private findExactTitleMatches(lowerQuery: string): IndexedFile[] {
        const matches: IndexedFile[] = [];
        
        for (const file of this.index.values()) {
            const lowerTitle = file.filename.toLowerCase();
            
            // Check for exact title match or title containing the exact word
            if (lowerTitle === lowerQuery || new RegExp(`\\b${lowerQuery}\\b`).test(lowerTitle)) {
                matches.push(file);
            }
        }
        
        return matches;
    }

    private findExactContentMatches(lowerQuery: string, excludePaths: Set<string>): IndexedFile[] {
        const matches: Array<{ file: IndexedFile; score: number }> = [];
        
        for (const file of this.index.values()) {
            if (excludePaths.has(file.path)) continue;
            
            const content = file.processed.tokens.join(' ').toLowerCase();
            if (new RegExp(`\\b${lowerQuery}\\b`).test(content)) {
                matches.push({ file, score: 70 });
            }
        }
        
        return matches
            .sort((a, b) => b.score - a.score)
            .map(result => result.file);
    }

    private findSemanticTitleMatches(lowerQuery: string, relatedTerms: string[], excludePaths: Set<string>): IndexedFile[] {
        const matches: IndexedFile[] = [];
        
        for (const file of this.index.values()) {
            if (excludePaths.has(file.path)) continue;
            
            const lowerTitle = file.filename.toLowerCase();
            // Check if title contains any related term as a whole word
            if (relatedTerms.some(term => new RegExp(`\\b${term}\\b`).test(lowerTitle))) {
                matches.push(file);
            }
        }
        
        return matches;
    }

    private rankResults(query: ProcessedQuery, relatedTerms: string[], excludePaths: Set<string>): IndexedFile[] {
        const results: Array<{ file: IndexedFile; score: number }> = [];
        
        for (const file of this.index.values()) {
            // Skip files that were already matched
            if (excludePaths.has(file.path)) continue;
            
            const score = this.calculateRelevanceScore(file, query, [...query.keywords, ...relatedTerms]);
            if (score > 0) {
                results.push({ file, score });
            }

            // Early return if we have enough high-quality results
            if (results.length >= 100) break;
        }

        return results
            .sort((a, b) => b.score - a.score)
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