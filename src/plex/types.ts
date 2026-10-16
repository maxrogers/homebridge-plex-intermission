// Shapes of the Plex responses the plugin reads. Only the fields it uses are declared.

export interface PlexPlayer {
  title?: string;
  uuid?: string;
  machineIdentifier?: string;
  product?: string;
  platform?: string;
  state?: string;
  local?: boolean | number | string;
}

export interface PlexAccount {
  id?: number;
  title?: string;
}

export interface PlexMetadata {
  ratingKey?: string;
  sessionKey?: string;
  type?: string;
  title?: string;
  grandparentTitle?: string;
  duration?: number | string;
  viewOffset?: number | string;
  librarySectionID?: number | string;
  librarySectionTitle?: string;
  Player?: PlexPlayer;
  User?: PlexAccount;
  Marker?: PlexMarker[];
}

export interface PlexMarker {
  type?: string;
  startTimeOffset?: number | string;
  endTimeOffset?: number | string;
  final?: boolean | number | string;
}

export interface PlexMediaContainer<T> {
  MediaContainer?: { Metadata?: T[] };
}

export interface PlexWebhookPayload {
  event?: string;
  user?: boolean;
  owner?: boolean;
  Account?: PlexAccount;
  Server?: { title?: string; uuid?: string };
  Player?: PlexPlayer;
  Metadata?: PlexMetadata;
}

export interface PlexPlayingNotification {
  sessionKey?: string;
  clientIdentifier?: string;
  ratingKey?: string;
  state?: string;
  viewOffset?: number | string;
}

export interface PlexNotificationContainer {
  NotificationContainer?: {
    type?: string;
    PlaySessionStateNotification?: PlexPlayingNotification[];
  };
}
