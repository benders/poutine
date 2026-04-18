import { Config } from "../config.js";

/**
 * Last.fm API response for artist.getinfo
 */
export interface LastFmArtistResponse {
  artist: {
    name: string;
    url: string;
    mbid?: string;
    image?: Array<{
      "#text": string;
      size: "small" | "medium" | "large" | "extralarge" | "mega";
    }>;
    stats?: {
      listeners: string;
      playcount: string;
    };
    tagcloud?: {
      tag: Array<{
        "#text": string;
        "@count": string;
      }>;
    };
    similar?: {
      artist: Array<{
        name: string;
        url: string;
        mbid?: string;
      }>;
    };
    bio?: {
      summary: string;
      content: string;
      links?: {
        link: Array<{
          "#text": string;
          "@rel": string;
          "@type": string;
          href: string;
        }>;
      };
    };
  };
}

/**
 * Image URL with size information
 */
export interface ArtistImage {
  url: string;
  size: "small" | "medium" | "large" | "extralarge";
}

/**
 * Last.fm API client for fetching artist images and metadata
 */
export class LastFmClient {
  private readonly apiKey: string;
  private readonly baseUrl = "https://ws.audioscrobbler.com/2.0/";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Check if Last.fm integration is enabled
   */
  isEnabled(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  /**
   * Get artist info from Last.fm
   * @param artistName - The name of the artist
   * @param musicBrainzId - Optional MusicBrainz ID for more accurate lookup
   */
  async getArtistInfo(
    artistName: string,
    musicBrainzId?: string
  ): Promise<LastFmArtistResponse | null> {
    if (!this.isEnabled()) {
      return null;
    }

    const params = new URLSearchParams({
      method: "artist.getinfo",
      api_key: this.apiKey,
      format: "json",
    });

    if (musicBrainzId) {
      params.set("mbid", musicBrainzId);
    } else {
      params.set("artist", artistName);
    }

    try {
      const response = await fetch(`${this.baseUrl}?${params.toString()}`, {
        headers: {
          "User-Agent": "poutine/0.2.0",
        },
      });

      if (!response.ok) {
        console.error(`Last.fm API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json();

      // Handle "not found" responses
      if (data.error === 6) {
        // Artist not found
        return null;
      }

      if (data.artist) {
        return data as LastFmArtistResponse;
      }

      return null;
    } catch (error) {
      console.error(`Last.fm API request failed: ${error}`);
      return null;
    }
  }

  /**
   * Extract image URLs from Last.fm response
   * @param artistInfo - The Last.fm artist info response
   * @returns Object with image URLs by size
   */
  extractImages(artistInfo: LastFmArtistResponse): {
    smallImageUrl?: string;
    mediumImageUrl?: string;
    largeImageUrl?: string;
    extralargeImageUrl?: string;
  } {
    if (!artistInfo.artist?.image || artistInfo.artist.image.length === 0) {
      return {};
    }

    const images: Record<string, string> = {};

    for (const img of artistInfo.artist.image) {
      if (img["#text"] && img.size) {
        images[`${img.size}ImageUrl`] = img["#text"];
      }
    }

    return {
      smallImageUrl: images.smallImageUrl,
      mediumImageUrl: images.mediumImageUrl,
      largeImageUrl: images.largeImageUrl,
      extralargeImageUrl: images.extralargeImageUrl,
    };
  }

  /**
   * Get the best available image URL (prefer larger sizes)
   */
  getBestImage(artistInfo: LastFmArtistResponse): string | null {
    const images = this.extractImages(artistInfo);
    return (
      images.extralargeImageUrl ??
      images.largeImageUrl ??
      images.mediumImageUrl ??
      images.smallImageUrl ??
      null
    );
  }
}
