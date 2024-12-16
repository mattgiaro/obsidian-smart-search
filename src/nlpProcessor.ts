import nlp from 'compromise';

type NlpDocument = ReturnType<typeof nlp>;

export interface ProcessedText {
    tokens: string[];
    entities: string[];
    topics: string[];
    sentiment: number;
}

export interface ProcessedQuery {
    intent: string;
    keywords: string[];
    entities: string[];
    relatedTerms: string[];
}

export class NLPProcessor {
    private depth: 'basic' | 'medium' | 'deep';
    private cache: Map<string, ProcessedText>;
    private synonymMap: Map<string, string[]>;

    constructor(depth: 'basic' | 'medium' | 'deep') {
        this.depth = depth;
        this.cache = new Map();
        this.initializeSynonymMap();
    }

    private initializeSynonymMap() {
        this.synonymMap = new Map([
            ['title', ['headline', 'heading', 'header', 'subject']],
            ['headline', ['title', 'heading', 'header', 'subject']],
            ['article', ['post', 'content', 'piece', 'writing']],
            ['content', ['article', 'post', 'text', 'material']],
            ['note', ['document', 'entry', 'record']],
            ['write', ['compose', 'author', 'create', 'draft']],
            ['create', ['make', 'produce', 'generate', 'write']],
            ['good', ['great', 'excellent', 'effective', 'powerful']],
            ['idea', ['concept', 'thought', 'insight', 'notion']]
        ]);
    }

    public processText(text: string): ProcessedText {
        // Check cache first
        const cached = this.cache.get(text);
        if (cached) return cached;

        const doc = nlp(text);
        
        const result: ProcessedText = {
            tokens: this.extractTokens(doc),
            entities: this.extractEntities(doc),
            topics: this.extractTopics(doc),
            sentiment: this.analyzeSentiment(doc)
        };

        // Cache the result
        this.cache.set(text, result);
        return result;
    }

    private extractTokens(doc: NlpDocument): string[] {
        return doc.terms().out('array') as string[];
    }

    private extractEntities(doc: NlpDocument): string[] {
        return [
            ...doc.people().out('array'),
            ...doc.places().out('array'),
            ...doc.organizations().out('array')
        ] as string[];
    }

    private extractTopics(doc: NlpDocument): string[] {
        switch (this.depth) {
            case 'basic':
                return doc.nouns().out('array') as string[];
            case 'medium':
                return [
                    ...doc.nouns().out('array'),
                    ...doc.verbs().out('array')
                ] as string[];
            case 'deep':
                return [
                    ...doc.nouns().out('array'),
                    ...doc.verbs().out('array'),
                    ...doc.adjectives().out('array'),
                    ...doc.match('#Noun+ (#Preposition #Noun+)?').out('array')
                ] as string[];
        }
    }

    private analyzeSentiment(doc: NlpDocument): number {
        const positive = doc.has('(good|great|excellent|amazing|wonderful)');
        const negative = doc.has('(bad|terrible|awful|horrible|poor)');
        
        if (positive && !negative) return 1;
        if (negative && !positive) return -1;
        return 0;
    }

    public processQuery(query: string): ProcessedQuery {
        const doc = nlp(query);
        
        return {
            intent: this.determineQueryIntent(doc),
            keywords: this.extractKeywords(doc),
            entities: this.extractEntities(doc),
            relatedTerms: this.findRelatedTerms(doc)
        };
    }

    private determineQueryIntent(doc: NlpDocument): string {
        if (doc.questions().found) return 'question';
        if (doc.has('#Imperative')) return 'command';
        return 'statement';
    }

    private extractKeywords(doc: NlpDocument): string[] {
        // Extract phrases first
        const phrases = doc.match('#Verb (a|the)? #Noun+').out('array') as string[];
        
        // Extract individual important words
        const words = [
            ...doc.nouns().out('array'),
            ...doc.verbs().out('array'),
            ...doc.adjectives().out('array')
        ].map(word => word.toLowerCase());

        // Combine phrases and words, removing duplicates
        return [...new Set([...phrases, ...words])];
    }

    private findRelatedTerms(doc: NlpDocument): string[] {
        // Get basic terms
        const terms = [
            ...doc.nouns().out('array'),
            ...doc.verbs().out('array'),
            ...doc.adjectives().out('array'),
            ...doc.adverbs().out('array')
        ].map(term => term.toLowerCase());

        // Add synonyms for each term
        const withSynonyms = terms.reduce((acc: string[], term) => {
            acc.push(term);
            const synonyms = this.synonymMap.get(term) || [];
            acc.push(...synonyms);
            return acc;
        }, []);

        // Convert to lowercase and remove duplicates
        return Array.from(new Set(withSynonyms));
    }
}