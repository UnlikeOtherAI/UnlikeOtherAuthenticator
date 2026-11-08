const messages:Record<string,string>={
  en:'The organisation and its active members remain. After deleting the last team, create a new team in the same organisation. Captured financial records and holds remain unchanged.',
  cs:'Organizace a její aktivní členové zůstávají zachováni. Po odstranění posledního týmu vytvořte nový tým ve stejné organizaci. Zachycené finanční záznamy a blokace se nemění.',
  de:'Die Organisation und ihre aktiven Mitglieder bleiben erhalten. Erstellen Sie nach dem Löschen des letzten Teams ein neues Team in derselben Organisation. Erfasste Finanzdaten und Sperren bleiben unverändert.',
  es:'La organización y sus miembros activos se conservan. Después de eliminar el último equipo, cree otro en la misma organización. Los registros financieros y las retenciones se mantienen sin cambios.',
  fr:'L’organisation et ses membres actifs sont conservés. Après la suppression de la dernière équipe, créez-en une dans la même organisation. Les données financières et les retenues restent inchangées.',
  it:'L’organizzazione e i suoi membri attivi restano. Dopo aver eliminato l’ultimo team, creane uno nella stessa organizzazione. I dati finanziari e i vincoli registrati rimangono invariati.',
};
export const teamDeletionScopeCopy=(locale=navigator.language)=>messages[locale.split('-')[0]??'en']??messages.en;
