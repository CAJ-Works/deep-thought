import os
import re
import json
import logging
import urllib.parse
import requests
from bs4 import BeautifulSoup
import google.generativeai as genai
import config
from config import (
    LM_STUDIO_BASE_URL,
    LM_STUDIO_MODEL,
    GEMINI_API_KEY
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configure Gemini API
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

class AIService:

    @staticmethod
    def query_lm_studio(prompt: str, system_prompt: str = "") -> str:
        """
        Queries the local LM Studio instance on the macOS host (port 1234) using standard OpenAI chat completion API.
        """
        try:
            url = f"{LM_STUDIO_BASE_URL}/chat/completions"
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": prompt})

            payload = {
                "model": LM_STUDIO_MODEL or "local-model",
                "messages": messages,
                "temperature": 0.3,
                "stream": False
            }
            
            response = requests.post(url, json=payload, timeout=120)
            if response.status_code == 200:
                result = response.json()
                choices = result.get("choices", [])
                if choices:
                    return choices[0].get("message", {}).get("content", "").strip()
            logger.warning(f"LM Studio API returned status code {response.status_code} or empty body.")
            return ""
        except Exception as e:
            logger.warning(f"Failed to query local LM Studio model: {e}")
            return ""

    @classmethod
    def query_llm(cls, prompt: str, system_prompt: str = "", use_gemini_fallback: bool = True) -> str:
        """
        Queries the local LM Studio model first, falling back to Gemini API if LM Studio is offline.
        """
        # Try LM Studio
        response = cls.query_lm_studio(prompt, system_prompt)
        if response:
            return response
            
        # Fall back to Gemini API
        if use_gemini_fallback and GEMINI_API_KEY:
            try:
                logger.info("LM Studio offline. Falling back to Gemini API...")
                model = genai.GenerativeModel(
                    "gemini-1.5-flash",
                    system_instruction=system_prompt if system_prompt else None
                )
                response = model.generate_content(prompt)
                return response.text.strip()
            except Exception as e:
                logger.error(f"Gemini fallback failed: {e}")
                
        return "[LLM generation failed: No model available]"

    @classmethod
    def categorize_thought(cls, content: str) -> str:
        """
        Categorizes a thought into a single short category.
        """
        system_prompt = (
            "You are a categorization assistant. Group the user's input into exactly one category name. "
            "Respond with only the category name (1-3 words max, e.g. 'Project Idea', 'Research', 'Personal', 'To-Do', 'Meeting Notes', 'General'). "
            "Do not include any quotes, periods, or extra explanation."
        )
        category = cls.query_llm(
            prompt=f"Classify this thought: '{content}'",
            system_prompt=system_prompt
        )
        # Clean up output
        category = category.replace('"', '').replace("'", "").strip()
        if category.startswith("[") or len(category) > 30:
            return "General"
        return category

    @classmethod
    def analyze_and_summarize(cls, content: str) -> str:
        """
        Generates a summary and metadata analysis of the thought.
        """
        system_prompt = (
            "You are a cognitive assistant. Provide a brief analysis of the user's thought. "
            "Include: 1) A 1-sentence concise summary. 2) Key entities or topics mentioned. "
            "Format the output as a clean, brief markdown response."
        )
        return cls.query_llm(
            prompt=f"Analyze this thought entry:\n\n{content}",
            system_prompt=system_prompt
        )

    @staticmethod
    def search_web_ddg(query: str, max_results: int = 3) -> list:
        """
        Performs web search via DuckDuckGo HTML parsing.
        """
        try:
            logger.info(f"Performing web research for query: '{query}'")
            headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}
            url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
            res = requests.get(url, headers=headers, timeout=10)
            
            if res.status_code != 200:
                logger.warning(f"DuckDuckGo returned status code {res.status_code}")
                return []
                
            soup = BeautifulSoup(res.text, "html.parser")
            results = []
            
            # Find result blocks
            for div in soup.find_all("div", class_="result__body")[:max_results]:
                a_title = div.find("a", class_="result__snippet")
                a_url = div.find("a", class_="result__url")
                
                if not a_url:
                    continue
                    
                title = a_title.text.strip() if a_title else "No Title"
                url_raw = a_url.get("href", "")
                
                # Extract real url
                parsed_url = urllib.parse.urlparse(url_raw)
                q_params = urllib.parse.parse_qs(parsed_url.query)
                real_url = q_params.get("uddg", [url_raw])[0]
                
                # Check for snippet
                snippet_div = div.find("a", class_="result__snippet")
                snippet = snippet_div.text.strip() if snippet_div else ""
                
                results.append({
                    "title": title,
                    "url": real_url,
                    "snippet": snippet
                })
            
            logger.info(f"Found {len(results)} web references.")
            return results
        except Exception as e:
            logger.error(f"DuckDuckGo search scraper failed: {e}")
            return []

    @classmethod
    def get_search_queries(cls, content: str) -> list:
        """
        Asks the LLM to generate 1-2 search queries for web research context.
        """
        system_prompt = (
            "You are a search assistant. Based on the user's thought, generate 1 or 2 specific search queries "
            "that would find background context or relevant links on Google. "
            "Format the output as a simple JSON array of strings, e.g. [\"query 1\", \"query 2\"]. "
            "Only return the JSON array, no other text."
        )
        response = cls.query_llm(
            prompt=f"Thought: '{content}'",
            system_prompt=system_prompt
        )
        try:
            # Extract JSON block using regex if LLM outputs markdown
            match = re.search(r"(\[.*?\])", response, re.DOTALL)
            if match:
                queries = json.loads(match.group(1))
                if isinstance(queries, list):
                    return [str(q) for q in queries]
        except Exception as e:
            logger.warning(f"Failed to parse search queries JSON: {e}. Raw response: {response}")
        
        # Fallback to simple query if JSON parsing fails
        words = content.split()[:5]
        return [" ".join(words)] if words else []

    @classmethod
    def generate_next_steps(cls, content: str, category: str, summary: str, web_references: list) -> str:
        """
        Generates a "Next steps" assessment expanding on the thought, based on content, summary, and web references.
        """
        web_refs_context = ""
        if web_references:
            web_refs_context = "\nWeb Research Findings:\n" + "\n".join(
                f"- [{r['title']}]({r['url']}): {r['snippet']}" for r in web_references
            )
            
        system_prompt = (
            "You are a cognitive expansion assistant. Generate a 'Next Steps' section that expands on the user's thought. "
            "Follow these rules:\n"
            "1. If the thought is a To-Do, recommend a concrete checklist or list of steps to accomplish it.\n"
            "2. If the thought is an Idea, build on it to suggest details, enhance it, or recommend areas to dig deeper.\n"
            "3. For other categories (e.g. Research, General), provide a helpful continuation, synthesis, or expansion.\n"
            "Use the provided summary and web research context if relevant. "
            "Format the output as a clean, brief markdown response."
        )
        
        prompt = (
            f"User Thought: '{content}'\n"
            f"Category: {category}\n"
            f"Structured Summary:\n{summary}\n"
            f"{web_refs_context}"
        )
        
        return cls.query_llm(prompt=prompt, system_prompt=system_prompt)



