/*
 * RSS Feed extension for GNOME Shell
 *
 * Copyright (C) 2015
 *     Tomas Gazovic <gazovic.tomasgmail.com>,
 *     Janka Gazovicova <jana.gazovicova@gmail.com>
 *
 * This file is part of gnome-shell-extension-rss-feed.
 *
 * gnome-shell-extension-rss-feed is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * gnome-shell-extension-rss-feed is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with gnome-shell-extension-rss-feed.  If not, see <http://www.gnu.org/licenses/>.
 */
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Soup = imports.gi.Soup;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const ScreenShield = imports.ui.screenShield;
const ExtensionSystem = imports.ui.extensionSystem;

const Mainloop = imports.mainloop;

const Me = imports.misc.extensionUtils.getCurrentExtension();

const Convenience = Me.imports.convenience;
const Parser = Me.imports.parsers.factory;
const Log = Me.imports.logger;
const Settings = Convenience.getSettings();

const Gettext = imports.gettext.domain('rss-feed');
const _ = Gettext.gettext;

const MessageTray = imports.ui.messageTray;

const Misc = Me.imports.misc;
const Clutter = imports.gi.Clutter;

const Encoder = Me.imports.encoder.getInstance();
const HTTP = Me.imports.http;

const ExtensionGui = {
	RssPopupMenuItem: Me.imports.extensiongui.rsspopupmenuitem.RssPopupMenuItem,
	RssPopupSubMenuMenuItem: Me.imports.extensiongui.rsspopupsubmenumenuitem.RssPopupSubMenuMenuItem,
	RssPopupMenuSection: Me.imports.extensiongui.rsspopupmenusection.RssPopupMenuSection
};

const RSS_FEEDS_LIST_KEY = 'rss-feeds-list';
const UPDATE_INTERVAL_KEY = 'update-interval';
const ITEMS_VISIBLE_KEY = 'items-visible';
const DEBUG_ENABLED_KEY = 'enable-debug';
const ENABLE_NOTIFICATIONS_KEY = 'enable-notifications';
const POLL_DELAY_KEY = 'fpoll-timeout';
const MAX_HEIGHT_KEY = 'max-height';
const ENABLE_ANIMATIONS_KEY = 'enable-anim';
const PRESERVE_ON_LOCK_KEY = 'preserve-on-lock';
const MAX_NOTIFICATIONS_KEY = 'notification-limit';
const ENABLE_DESC_KEY = 'enable-descriptions';
const MB_ALIGN_TOP_KEY = 'menu-buttons-align-top';
const NOTIFICATIONS_ON_LOCKSCREEN = 'enable-notifications-locked';
const CLEANUP_NOTIFICATIONS = 'notifications-cleanup'

const NOTIFICATION_ICON = 'application-rss+xml';

let _preserveOnLock = false;

/*
 * Main RSS Feed extension class
 */
const RssFeed = new Lang.Class(
{
	Name: 'RssFeed',
	Extends: PanelMenu.Button,

	/*
	 * Initialize instance of RssFeed class
	 */
	_init: function()
	{
		this.parent(0.0, "RSS Feed");

		this._httpSession = new Soup.SessionAsync({
			timeout: 60
		});

		// Lours974 Vitry David
		// This makes the session work under a proxy. The funky syntax here
		// is required because of another libsoup quirk, where there's a gobject
		// property called 'add-feature', designed as a construct property for
		// C convenience.
		Soup.Session.prototype.add_feature.call(this._httpSession, new Soup.ProxyResolverDefault());

		this._startIndex = 0;
		this._feedsCache = new Array();
		this._feedTimers = new Array();
		this._notifCache = new Array();

		this._totalUnreadCount = 0;
		this._notifLimit = 10;

		this._miStPadding = Array(158).join(" ");

		// top panel button
		let button = new St.BoxLayout(
		{
			vertical: false,
			style_class: 'panel-status-menu-box'
		});

		this._iconLabel = new St.Label(
		{
			text: '',
			y_expand: true,
			y_align: Clutter.ActorAlign.START,
			style_class: 'rss-icon-label'
		});

		let icon = new St.Icon(
		{
			icon_name: 'application-rss+xml-symbolic',
			style_class: 'system-status-icon'
		});

		button.add_child(icon);
		button.add_child(this._iconLabel);

		this.actor.add_actor(button);
		
		this.menu.actor.add_style_class_name('rss-menu');
		
		this.menu.connect('open-state-changed', Lang.bind(this, function(self, open)
		{
			if (open && this._lastOpen)
				this._lastOpen.open();
		}));

		let separator = new PopupMenu.PopupSeparatorMenuItem();
		
		let mbAlignTop = Settings.get_boolean(MB_ALIGN_TOP_KEY);

		if ( mbAlignTop )
		{
			this._createMainPanelButtons();	
			this.menu.addMenuItem(separator);
		}

		this._pMaxMenuHeight = Settings.get_int(MAX_HEIGHT_KEY);

		this._feedsSection = new ExtensionGui.RssPopupMenuSection(
			this._generatePopupMenuCSS(this._pMaxMenuHeight)
		);

		this.menu.addMenuItem(this._feedsSection);
		
		if ( !mbAlignTop )
		{
			this.menu.addMenuItem(separator);
			this._createMainPanelButtons();	
		}
	},
	
	_createMainPanelButtons: function()
	{
		let systemMenu = Main.panel.statusArea.aggregateMenu._system;

		// buttons
		this._buttonMenu = new PopupMenu.PopupBaseMenuItem(
		{
			reactive: false
		});

		this._lastUpdateTime = new St.Label(
		{
			text: "Initializing..",
			style_class: 'rss-status-label'
		});

		if (Settings.get_boolean(DEBUG_ENABLED_KEY))
		{
			let reloadPluginBtn = systemMenu._createActionButton('system-shutdown-symbolic', _("Reload Plugin"));
			this._buttonMenu.actor.add_actor(reloadPluginBtn);
			reloadPluginBtn.connect('clicked', Lang.bind(this, function()
			{
				if (this._reloadTimeout || Misc.isScreenLocked())
					return;

				this._reloadTimeout = Mainloop.timeout_add(0, function()
				{
					ExtensionSystem.reloadExtension(Me);
				});
			}));

		}

		this._buttonMenu.actor.add_actor(this._lastUpdateTime);
		this._buttonMenu.actor.set_x_align(Clutter.ActorAlign.CENTER);

		this._lastUpdateTime.set_y_align(Clutter.ActorAlign.CENTER);

		let reloadBtn = systemMenu._createActionButton('view-refresh-symbolic', _("Reload RSS Feeds"));
		let settingsBtn = systemMenu._createActionButton('emblem-system-symbolic', _("RSS Feed Settings"));

		this._buttonMenu.actor.add_actor(reloadBtn);
		this._buttonMenu.actor.add_actor(settingsBtn);

		reloadBtn.connect('clicked', Lang.bind(this, this._pollFeeds));
		settingsBtn.connect('clicked', Lang.bind(this, this._onSettingsBtnClicked));

		this.menu.addMenuItem(this._buttonMenu);
		
	},

	/*
	 * Frees resources of extension
	 */
	destroy: function()
	{
		this._isDiscarded = true;

		if (this._httpSession)
			this._httpSession.abort();

		this._httpSession = undefined;

		if (this._scid)
			Settings.disconnect(this._scid);

		if (this._timeout)
			Mainloop.source_remove(this._timeout);

		if (this._settingsCWId)
			Mainloop.source_remove(this._settingsCWId);

		for (let t in this._feedTimers)
			Mainloop.source_remove(t);
		
		if (Settings.get_boolean(CLEANUP_NOTIFICATIONS))
		{
			let notifCache = this._notifCache;
	
			while (notifCache.length > 0)
				notifCache.shift().destroy();
		}

		this.parent();
	},

	_updateUnreadCountLabel: function(count)
	{
		var text = !count ? '' : count.toString();

		if (text != this._iconLabel.get_text())
			this._iconLabel.set_text(text);
	},

	_generatePopupMenuCSS: function(value)
	{
		return "max-height: " + value + "px;";
	},

	/*
	 * Get variables from GSettings
	 */
	_getSettings: function()
	{
		this._updateInterval = Settings.get_int(UPDATE_INTERVAL_KEY);
		this._itemsVisible = Settings.get_int(ITEMS_VISIBLE_KEY);
		this._rssFeedsSources = Settings.get_strv(RSS_FEEDS_LIST_KEY);
		this._rssPollDelay = Settings.get_int(POLL_DELAY_KEY);
		this._enableNotifications = Settings.get_boolean(ENABLE_NOTIFICATIONS_KEY);
		this._maxMenuHeight = Settings.get_int(MAX_HEIGHT_KEY);
		this._feedsSection._animate = Settings.get_boolean(ENABLE_ANIMATIONS_KEY);
		this._notifLimit = Settings.get_int(MAX_NOTIFICATIONS_KEY);
		//this._showDesc = Settings.get_boolean(ENABLE_DESC_KEY);
		this._notifOnLockScreen = Settings.get_boolean(NOTIFICATIONS_ON_LOCKSCREEN);

		_preserveOnLock = Settings.get_boolean(PRESERVE_ON_LOCK_KEY);
	},

	/*
	 * On settings button clicked callback
	 */
	_onSettingsBtnClicked: function()
	{
		if (Misc.isScreenLocked())
			return;

		var success, pid;
		try
		{
			[success, pid] = GLib.spawn_async(null, ["gnome-shell-extension-prefs", Me.uuid], null,
				GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
				null);
		}
		catch (err)
		{
			return;
		}

		if (!success)
			return;

		this.menu.close();

		this._settingsCWId = GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, Lang.bind(this, function(pid, status)
		{
			this._settingsCWId = undefined;

			GLib.spawn_close_pid(pid);

			this._pollFeeds();
		}));
	},

	_purgeSource: function(key)
	{
		let feedsCache = this._feedsCache[key];

		if (!feedsCache)
			return;

		this._totalUnreadCount -= feedsCache.UnreadCount;
		this._updateUnreadCountLabel(this._totalUnreadCount);

		if (feedsCache.Menu)
			feedsCache.Menu.destroy();

		delete this._feedsCache[key];
		this._feedsCache[key] = undefined;
	},

	_restartExtension: function()
	{
		if (!this._reloadTimer)
		{
			this._reloadTimer = Mainloop.timeout_add(0, function()
			{
				extension_disable();
				enable();
			});
		}
	},

	/*
	 * Scheduled reload of RSS feeds from sources set in settings
	 */
	_pollFeeds: function()
	{
		this._getSettings();

		if (this._maxMenuHeight != this._pMaxMenuHeight)
			this._feedsSection.actor.set_style(
				this._generatePopupMenuCSS(this._maxMenuHeight));

		this._pMaxMenuHeight = this._maxMenuHeight;

		Log.Debug("Reload RSS Feeds");

		if (this._feedTimers.length)
		{
			for (let t in this._feedTimers)
				Mainloop.source_remove(t);

			this._feedTimers = new Array();
		}

		// remove timeout
		if (this._timeout)
			Mainloop.source_remove(this._timeout);

		if (this._rssFeedsSources)
		{
			/* clear feed list if necessary */
			if ((this._pItemsVisible &&
					this._itemsVisible > this._pItemsVisible))
			{
				this._feedsSection.removeAll();
				delete this._feedsCache;
				this._feedsCache = new Array();

				this._totalUnreadCount = 0;
				this._updateUnreadCountLabel(0);
			}

			this._pItemsVisible = this._itemsVisible;

			/* cleanup after removed sources */
			if (this._feedsCache)
			{
				for (var key in this._feedsCache)
				{
					let h = false;

					for (let j = 0; j < this._rssFeedsSources.length; j++)
					{
						let url = this._rssFeedsSources[j];

						if (key == url)
						{
							h = true;
							break;
						}
					}

					if (!h)
						this._purgeSource(key);
				}
			}

			for (let i = 0; i < this._rssFeedsSources.length; i++)
			{
				let url = this._rssFeedsSources[i];
				let sourceURL = url;

				if (!url.length)
					continue;

				let jsonObj = HTTP.getParametersAsJson(url);

				let l2o = url.indexOf('?');
				if (l2o != -1) url = url.substr(0, l2o);

				let sourceID = Mainloop.timeout_add(i * this._rssPollDelay, Lang.bind(this, function()
				{
					this._httpGetRequestAsync(url, JSON.parse(jsonObj), sourceURL, Lang.bind(this, this._onDownload));
					delete this._feedTimers[sourceID];
				}))

				this._feedTimers[sourceID] = true;
			}
		}

		// set timeout if enabled
		if (this._updateInterval > 0)
		{
			Log.Debug("Next scheduled reload after " + this._updateInterval * 60 + " seconds");
			this._timeout = Mainloop.timeout_add_seconds(this._updateInterval * 60, Lang.bind(this, function()
			{
				this._timeout = undefined;
				this._pollFeeds();
			}));
		}
	},

	/*
	 * Creates asynchronous HTTP GET request through Soup interface url - HTTP
	 * request URL without parameters params - JSON object of HTTP GET request
	 * sourceURL - original URL used as cache key
	 * HTTP GET request response
	 */
	_httpGetRequestAsync: function(url, params, sourceURL, callback)
	{
		let request = Soup.form_request_new_from_hash('GET', url, params);

		if (!request)
		{
			Log.Debug("Soup.form_request_new_from_hash returned 'null' for URL '" + url + "'");
			return;
		}

		this._httpSession.queue_message(request, Lang.bind(this, function(httpSession, message)
		{
			let status_phrase = Soup.Status.get_phrase(message.status_code);

			if ( !((message.status_code) >= 200 && (message.status_code) < 300) )
			{
				Log.Debug("HTTP GET " + sourceURL + ": " + message.status_code + " " + status_phrase);
				return;
			}

			Log.Debug("HTTP GET " + sourceURL + ": " + message.status_code + " " + status_phrase +
				" Content-Type: " + message.response_headers.get_one("Content-Type"));

			if (message.response_body.data)
				callback(message.response_body.data, sourceURL);
		}));
	},

	/*
	 * On HTTP request response download callback responseData - response data
	 * sourceURL - original URL used as cache key
	 */
	_onDownload: function(responseData, sourceURL)
	{
		let rssParser = Parser.createRssParser(responseData);

		if (rssParser == null)
		{
			this._purgeSource(sourceURL);
			return;
		}

		rssParser.parse();

		let nItems = rssParser.Items.length > this._itemsVisible ? this._itemsVisible : rssParser.Items.length;

		if (!nItems)
			return;

		let feedsCache;

		if (!this._feedsCache[sourceURL])
		{
			// initialize the publisher cache array
			feedsCache = this._feedsCache[sourceURL] = new Object();
			feedsCache.Items = new Array();
			feedsCache.UnreadCount = 0;
			feedsCache.pUnreadCount = 0;
			feedsCache.parentClass = this;
		}
		else
			feedsCache = this._feedsCache[sourceURL];

		let itemCache = feedsCache.Items;

		let subMenu;

		// create publisher submenu
		if (!feedsCache.Menu)
		{
			subMenu = new ExtensionGui.RssPopupSubMenuMenuItem(rssParser.Publisher, nItems);
			this._feedsSection.addMenuItem(subMenu);

			subMenu.menu.connect('open-state-changed', Lang.bind(this, function(self, open)
			{
				if (open)
					this._lastOpen = self;
				else if (this.menu.isOpen && this._lastOpen == self)
					this._lastOpen = undefined;
			}));

			subMenu.menu.connect('destroy', Lang.bind(this, function(self, open)
			{
				if (this._lastOpen == self)
					this._lastOpen = undefined;
			}));

			feedsCache.Menu = subMenu;
		}
		else
			subMenu = feedsCache.Menu;

		/* clear any cache items which are no longer 
		 * required or should be updated
		 */
		let i = itemCache.length;

		while (i--)
		{
			let cacheItemURL = itemCache[i];
			let cacheObj = itemCache[cacheItemURL];
			let j = nItems;
			let h = false;

			while (j--)
			{
				let item = rssParser.Items[j];

				if (cacheItemURL == item.HttpLink)
				{
					if (cacheObj.Item.PublishDate != item.PublishDate ||
						cacheObj.Item.UpdateTime != item.UpdateTime)
					{
						item._update = true;
					}
					else
						h = true;

					break;
				}
			}
			if (!h)
			{
				cacheObj.Menu.destroy();

				if (cacheObj.Unread)
				{
					cacheObj.Unread = null;
					feedsCache.UnreadCount--;
					this._totalUnreadCount--;
				}

				delete itemCache[cacheItemURL];
				itemCache[cacheItemURL] = undefined;
				itemCache.splice(i, 1);
			}
		}

		let i = nItems;

		while (i--)
		{
			let item = rssParser.Items[i];
			let itemURL = item.HttpLink;

			/* we've already processed this item, move on.. */
			if (itemCache[itemURL])
				continue;

			/* remove HTML tags */
			item.Title = Encoder.htmlDecode(item.Title)
							.replace(/<.*?>/g, "").trim();

			/* create the menu item in publisher submenu */
			let menu = new ExtensionGui.RssPopupMenuItem(item);
			subMenu.menu.addMenuItem(menu, 0);
			//menu.label.set_style('max-width: 700px;');

			/* enter it into cache */
			let cacheObj = new Object();
			cacheObj.Menu = menu;
			cacheObj.Item = item;
			cacheObj.parent = feedsCache;
			cacheObj.lText = menu.label.get_text();
			itemCache[itemURL] = cacheObj;
			itemCache.push(itemURL);

			menu._cacheObj = cacheObj;

			// this._lMenu = menu;
			// if (i < 5 && Math.random() < 0.17332) feedsCache._initialRefresh = true;

			/* decode description, if present */
			if (item.Description.length > 0)
			{
				let itemDescription = Encoder.htmlDecode(item.Description)
					.replace("<![CDATA[", "").replace("]]>", "")
					.replace(/<.*?>/g, "").trim();

				if (itemDescription.length > 0)
				{
					/* word-break it for in-menu descriptions */
					cacheObj._bItemDescription = Misc.lineBreak(itemDescription, 80, 90, "  ");

					/* trim the description shown in notifications */
					if (itemDescription.length > 290)
						itemDescription = itemDescription.substr(0, 290) + "...";

					cacheObj._itemDescription = itemDescription;

					/* 
					 *  show description inside the article label, when selected 
					 *
					 *  FIXME:
					 *  This is not an ideal solution, it should be replaced with
					 *  a free-floating (not bound to the menu) tooltip or similar.
					 */
					menu.connect('active-changed', Lang.bind(this, function(self, over)
					{
						if (!Settings.get_boolean(ENABLE_DESC_KEY))
							return;

						let label_actor = self.actor.label_actor;

						if (over)
						{
							label_actor._originalHeight = label_actor.get_height();

							label_actor.set_text(
								self._cacheObj.lText + "\n  " +
								this._miStPadding + "\n" +
								self._cacheObj._bItemDescription
							);

							label_actor.set_height(120);
						}
						else
						{
							label_actor.set_text(self._cacheObj.lText);
							label_actor.set_height(label_actor._originalHeight);
						}
					}));
				}
			}

			/* do not notify or flag if this is the first query */
			if (!feedsCache._initialRefresh)
				continue;

			/* increment unread counts and flag item as unread */
			feedsCache.UnreadCount++;
			this._totalUnreadCount++;
			cacheObj.Unread = true;

			/* decorate menu item, indicating it unread */
			menu.setOrnament(PopupMenu.Ornament.DOT);

			/* trigger notification, if requested */
			if (this._enableNotifications )
			{
				let itemTitle = Encoder.htmlDecode(item.Title);

				cacheObj.Notification = this._dispatchNotification(
					item._update ? (_("UPDATE") + ': ' + itemTitle) : itemTitle,
					_("Source") + ': ' + Encoder.htmlDecode(rssParser.Publisher.Title) +
					(item.Author.length ? ', ' + _("Author") + ': ' + Encoder.htmlDecode(item.Author) : '') + '\n\n' +
					(cacheObj._itemDescription ? cacheObj._itemDescription : itemTitle),
					itemURL, cacheObj);
			}
		}

		if (!feedsCache._initialRefresh)
			feedsCache._initialRefresh = true;
		else
		{
			if (feedsCache.UnreadCount)
			{
				if (feedsCache.UnreadCount != feedsCache.pUnreadCount)
					subMenu.label.set_text(
						Misc.clampTitle(subMenu._olabeltext +
							' (' + feedsCache.UnreadCount + ')'));

				feedsCache.pUnreadCount = feedsCache.UnreadCount;

				subMenu.setOrnament(PopupMenu.Ornament.DOT);

				this._updateUnreadCountLabel(this._totalUnreadCount);
			}
		}

		// update last download time
		this._lastUpdateTime.set_text(_("Last update") + ': ' + new Date().toLocaleTimeString());

	},

	_removeExcessNotifications: function()
	{
		let notifCache = this._notifCache;

		while (notifCache.length > this._notifLimit)
			notifCache.shift().destroy();
	},

	_dispatchNotification: function(title, message, url, cacheObj)
	{
		/*
		 * Since per-source notification limit cannot be set, we create a new
		 * source each time.
		 */
		let Source = new MessageTray.SystemNotificationSource();
		Source.createIcon = function()
		{
			return new St.Icon(
			{
				icon_name: NOTIFICATION_ICON
			});
		};

		/* When enabled, always show details */
		Source.policy.detailsInLockScreen =
			Source.policy.showInLockScreen = this._notifOnLockScreen;

		Main.messageTray.add(Source);

		let notification = new MessageTray.Notification(Source, title, message);

		let notifCache = this._notifCache;

		if (url.length > 0)
		{
			/* remove notifications with same URL */
			let i = notifCache.length;

			while (i--)
			{
				let nCacheObj = notifCache[i];
				if (nCacheObj._itemURL == url)
				{
					nCacheObj.destroy();
					notifCache.splice(i, 1);
					break;
				}
			}

			notification._itemURL = url;
			notification._cacheObj = cacheObj;

			notification.addAction(_('Open URL'), Lang.bind(this, function()
			{
				Misc.processLinkOpen(notification._itemURL, notification._cacheObj);
				notification.destroy();
			}));

			notification.addAction(_('Copy URL'), function()
			{
				St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, notification._itemURL);

				/* don't destroy notification, just hide the banner */
				if (Main.messageTray._banner)
					Main.messageTray._banner.emit('done-displaying');
			});

			notification.connect('activated', Lang.bind(this, function(self)
			{
				Misc.processLinkOpen(self._itemURL, self._cacheObj);
				self.destroy();
			}));

			notification.setResident(true);
		}

		/*
		 * Destroy the source after notification is gone
		 */
		notification.connect('destroy', Lang.bind(this, function(self)
		{
			self.source.destroy();
		}));

		notification.setTransient(false);
		notification.setUrgency(MessageTray.Urgency.HIGH);

		notifCache.push(notification);

		/* remove excess notifications */
		this._removeExcessNotifications();

		Source.notify(notification);

		return notification;
	}

});

/*
 * Extension widget instance
 */
let rssFeed;

/*
 * Initialize the extension
 */
function init()
{
	Convenience.initTranslations("rss-feed");

	// hack for dconf
	Settings.set_boolean(DEBUG_ENABLED_KEY,
		Settings.get_boolean(DEBUG_ENABLED_KEY));

	Log.Debug("Extension initialized.");
}

/*
 * Enable the extension
 */
function enable()
{
	if (rssFeed)
	{
		Log.Debug("Extension already enabled!");
		return;
	}

	rssFeed = new RssFeed();
	Main.panel.addToStatusArea('rssFeedMenu', rssFeed, 0, 'right');

	Log.Debug("Extension enabled.");

	try
	{
		rssFeed._pollFeeds();
	} catch (e) {}
}

function extension_disable()
{
	if (!rssFeed)
	{
		Log.Debug("Extension already disabled!");
		return;
	}

	rssFeed.destroy();
	rssFeed = undefined;

	Log.Debug("Extension disabled.");
}

/*
 * Disable the extension
 */
function disable()
{
	_preserveOnLock = Settings.get_boolean(PRESERVE_ON_LOCK_KEY);

	if (_preserveOnLock &&
		Misc.isScreenLocked())
	{
		Log.Debug("Not disabling extension while screen inactive.");
		return;
	}

	extension_disable();
}
